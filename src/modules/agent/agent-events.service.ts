import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { KeyPrefixer } from '@/shared/caching/cache.prefixer';
import { AgentEvent, AgentEventType, IAgentStreamEntry } from './agent.types';

/** Stream 最多保留事件数（近似裁剪），单条事件 < 0.5KB，5000 条约 2.5MB/run */
const STREAM_MAXLEN = 5000;
/** Stream / sequence key 存活时间：与 LangGraph checkpoint TTL 对齐（24h） */
const STREAM_TTL_SECONDS = 60 * 60 * 24;
/** 回放历史时每页条数 */
const BACKLOG_PAGE_SIZE = 200;
/** 回放历史最多页数（200 * 25 = 5000，与 STREAM_MAXLEN 对齐） */
const BACKLOG_MAX_PAGES = 25;
/** XREAD BLOCK 超时（ms）；需小于 SSE 心跳间隔，超时返回 null 让调用方做终态判断 */
const XREAD_BLOCK_MS = 10_000;
/** 单次 XREAD 最多返回条数 */
const XREAD_COUNT = 100;

/** Redis Stream entry id 形如 `<millis>-<seq>`；'0-0' 表示从头读 */
const STREAM_ID_PATTERN = /^\d+-\d+$/;

export const isValidStreamId = (id: unknown): id is string =>
  typeof id === 'string' && STREAM_ID_PATTERN.test(id);

/** 比较两个 stream entry id：>0 表示 a 更新 */
export const compareStreamId = (a: string, b: string): number => {
  const [aMs, aSeq] = a.split('-').map(Number);
  const [bMs, bSeq] = b.split('-').map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return aSeq - bSeq;
};

export interface AgentEventTailOptions {
  /**
   * 从该 transportId 之后开始读（不含）。
   * 对应 SSE Last-Event-ID；不传则从 stream 头部开始（含完整历史回放）。
   */
  afterId?: string;
}

/**
 * SSE 尾读句柄。异步迭代产出新事件；
 * BLOCK 超时时产出 null（无新事件），由调用方决定是否继续等待。
 */
export interface AgentEventTail extends AsyncIterable<IAgentStreamEntry | null> {
  close(): Promise<void>;
}

/**
 * Agent 事件流骨干（Redis Stream）。
 *
 * 链路：Agent Event Layer → XADD(per-run stream) → XREAD BLOCK → SSE → Browser
 *
 * 相比 Pub/Sub fire-and-forget，Stream 带来：
 *   1. 持久缓冲：SSE 连接建立之前 / 断线期间的事件不丢；
 *   2. 有序回放：entry id 单调递增，浏览器凭 Last-Event-ID 续传；
 *   3. 跨实例：任何应用实例都能 XREAD 同一个 run 的 stream。
 *
 * sequence 是 run 维度业务序号，由 Redis INCR 在跨实例间保证严格递增；
 * transportId（stream entry id）是传输层偏移，两者各司其职。
 *
 * Redis 不可用时降级为进程内 ring buffer + Subject（仅单实例，与项目其他
 * Redis 依赖的降级策略一致）；写失败也会自动回退到本地总线，尽力不丢事件。
 */
@Injectable()
export class AgentEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentEventsService.name);

  /** XREAD BLOCK 需要独占连接，每个 SSE 尾读复制一条；统一登记以便关停 */
  private readonly tailClients = new Set<RedisClientType>();

  // ── 无 Redis 时的进程内降级状态 ──
  private readonly localBuffers = new Map<string, IAgentStreamEntry[]>();
  private readonly localSequences = new Map<string, number>();
  private readonly localBus = new Map<string, Subject<IAgentStreamEntry>>();

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: RedisClientType | null,
    private readonly prefixer: KeyPrefixer,
  ) {}

  private streamKey(runId: string): string {
    return this.prefixer.prefix(`agent:events:${runId}`);
  }

  private sequenceKey(runId: string): string {
    return this.prefixer.prefix(`agent:events:seq:${runId}`);
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  /**
   * 追加一个事件到 run 的 stream。
   * 不应因事件基础设施故障中断图执行：Redis 写失败时降级到本地总线。
   */
  async append(
    runId: string,
    type: AgentEventType,
    data: unknown,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      eventId: randomUUID(),
      runId,
      type,
      timestamp: Date.now(),
      data,
      sequence: 0,
    };

    if (this.redis?.isOpen) {
      try {
        event.sequence = await this.nextSequence(runId);
        await this.redis.xAdd(
          this.streamKey(runId),
          '*',
          { e: JSON.stringify(event) },
          {
            TRIM: {
              strategy: 'MAXLEN',
              strategyModifier: '~',
              threshold: STREAM_MAXLEN,
            },
          },
        );
        // 每次写入刷新 TTL：stream 在最后一个事件后保留 24h
        await this.redis.expire(this.streamKey(runId), STREAM_TTL_SECONDS);
        return event;
      } catch (err) {
        this.logger.warn(
          `Redis Stream XADD 失败，降级为进程内事件 runId=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // 继续走本地降级（序号由本地计数器重新分配）
      }
    }

    return this.appendLocal(event);
  }

  /** INCR 取全局递增序号，并刷新序号 key TTL（MULTI pipeline 一次往返） */
  private async nextSequence(runId: string): Promise<number> {
    const replies = (await this.redis!.multi()
      .incr(this.sequenceKey(runId))
      .expire(this.sequenceKey(runId), STREAM_TTL_SECONDS)
      .exec()) as unknown as Array<number | string>;
    return Number(replies[0]);
  }

  // ── 回放 + 尾读 ─────────────────────────────────────────────────────────

  /**
   * 非阻塞回放 afterId 之后的历史事件（分页拉满，避免回放与尾读之间出现缺口）。
   * Redis 不可用 / 读失败时回退到进程内 ring buffer。
   */
  async listBacklog(
    runId: string,
    afterId?: string,
  ): Promise<IAgentStreamEntry[]> {
    if (this.redis?.isOpen) {
      try {
        const entries: IAgentStreamEntry[] = [];
        let start: RedisStreamId = afterId ? `(${afterId}` : '-';
        for (let page = 0; page < BACKLOG_MAX_PAGES; page++) {
          const messages = await this.redis.xRange(
            this.streamKey(runId),
            start,
            '+',
            { COUNT: BACKLOG_PAGE_SIZE },
          );
          if (!messages.length) break;
          for (const message of messages) {
            entries.push(this.toEntry(message.id, message.message));
          }
          if (messages.length < BACKLOG_PAGE_SIZE) break;
          // 下一页从本页最后一条之后继续（排他区间）
          start = `(${messages[messages.length - 1].id}`;
        }
        return entries;
      } catch (err) {
        this.logger.warn(
          `Redis Stream XRANGE 失败，回退本地缓冲 runId=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return this.listLocalBacklog(runId, afterId);
  }

  /**
   * 创建尾读：从 afterId 之后 XREAD BLOCK 持续读取。
   * 每次调用复制一条独立 Redis 连接（BLOCK 期间连接被占用），调用方必须 close。
   * Redis 不可用时返回进程内降级尾读。
   */
  async createTail(
    runId: string,
    options: AgentEventTailOptions = {},
  ): Promise<AgentEventTail> {
    if (this.redis) {
      try {
        return await this.createRedisTail(runId, options.afterId);
      } catch (err) {
        this.logger.warn(
          `Redis Stream XREAD 尾读初始化失败，降级进程内尾读 runId=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return this.createLocalTail(runId, options.afterId);
  }

  private async createRedisTail(
    runId: string,
    afterId?: string,
  ): Promise<AgentEventTail> {
    const client = this.redis!.duplicate();
    if (client.options) client.options.disableOfflineQueue = true;
    client.on('error', (err: unknown) => {
      this.logger.warn(
        `Agent XREAD client error runId=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    await client.connect();
    this.tailClients.add(client);

    const key = this.streamKey(runId);
    // XREAD 的 id 为排他游标：返回严格新于该 id 的 entry；'0-0' 即全量历史
    let lastId = isValidStreamId(afterId) ? afterId : '0-0';
    let closed = false;

    const iterator = (async function* (
      service: AgentEventsService,
    ): AsyncGenerator<IAgentStreamEntry | null> {
      try {
        while (!closed) {
          const reply = await client.xRead(
            { key, id: lastId },
            { BLOCK: XREAD_BLOCK_MS, COUNT: XREAD_COUNT },
          );
          if (closed) return;
          if (!reply) {
            yield null;
            continue;
          }
          let produced = false;
          for (const stream of reply) {
            for (const message of stream.messages) {
              lastId = message.id;
              produced = true;
              yield service.toEntry(message.id, message.message);
            }
          }
          // 理论上 xRead 有响应必带消息；防御性处理空数组避免 busy loop
          if (!produced) yield null;
        }
      } catch (err) {
        if (!closed) {
          service.logger.warn(
            `Agent XREAD 中断 runId=${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // 让迭代器结束，SSE 侧关闭后浏览器会带 Last-Event-ID 自动重连
        return;
      } finally {
        service.releaseTailClient(client);
        try {
          // disconnect 立即关闭 socket，不必等 BLOCK 返回
          await client.disconnect();
        } catch {
          // 连接已失效
        }
      }
    })(this);

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async close() {
        closed = true;
        try {
          await client.disconnect();
        } catch {
          // 连接已失效
        }
      },
    };
  }

  private releaseTailClient(client: RedisClientType): void {
    this.tailClients.delete(client);
  }

  private toEntry(transportId: string, message: unknown): IAgentStreamEntry {
    const raw: unknown =
      message instanceof Map
        ? (message as Map<unknown, unknown>).get('e')
        : (message as Record<string, unknown> | null | undefined)?.e;
    let event: AgentEvent;
    try {
      event = JSON.parse(String(raw)) as AgentEvent;
    } catch (err) {
      // 坏消息不应拖垮整条 SSE：包成 error 事件继续下发
      this.logger.warn(
        `Agent Stream 消息反序列化失败 id=${transportId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      event = {
        eventId: randomUUID(),
        runId: '',
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'corrupted_event' },
        sequence: 0,
      };
    }
    return { transportId, event };
  }

  // ── 进程内降级实现 ──────────────────────────────────────────────────────

  private appendLocal(event: AgentEvent): AgentEvent {
    const runId = event.runId;
    const sequence = (this.localSequences.get(runId) ?? 0) + 1;
    this.localSequences.set(runId, sequence);
    event.sequence = sequence;

    const entry: IAgentStreamEntry = {
      transportId: `${event.timestamp}-${sequence}`,
      event,
    };

    const buffer = this.localBuffers.get(runId) ?? [];
    buffer.push(entry);
    if (buffer.length > STREAM_MAXLEN) buffer.shift();
    this.localBuffers.set(runId, buffer);

    this.localBus.get(runId)?.next(entry);
    return event;
  }

  private listLocalBacklog(
    runId: string,
    afterId?: string,
  ): IAgentStreamEntry[] {
    const buffered = this.localBuffers.get(runId) ?? [];
    if (!afterId) return [...buffered];
    return buffered.filter(
      (entry) => compareStreamId(entry.transportId, afterId) > 0,
    );
  }

  private createLocalTail(runId: string, afterId?: string): AgentEventTail {
    let bus = this.localBus.get(runId);
    if (!bus) {
      bus = new Subject<IAgentStreamEntry>();
      this.localBus.set(runId, bus);
    }

    let closed = false;
    // 先订阅再快照，避免“快照后、订阅前”事件丢失：
    // 订阅生效到快照之间到达的事件先暂存 early，再按 transportId 与快照去重。
    const early: IAgentStreamEntry[] = [];
    let started = false;
    const subscription = bus.subscribe({
      next: (entry) => {
        if (afterId && compareStreamId(entry.transportId, afterId) <= 0) return;
        if (started) pushEntry(entry);
        else early.push(entry);
      },
    });

    const snapshot = this.listLocalBacklog(runId, afterId);
    const snapshotIds = new Set(snapshot.map((entry) => entry.transportId));
    const queue: IAgentStreamEntry[] = [...snapshot];
    for (const entry of early) {
      if (!snapshotIds.has(entry.transportId)) queue.push(entry);
    }
    started = true;

    let wake: (() => void) | null = null;

    function pushEntry(entry: IAgentStreamEntry) {
      queue.push(entry);
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    }

    const iterator =
      (async function* (): AsyncGenerator<IAgentStreamEntry | null> {
        try {
          while (!closed) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          subscription.unsubscribe();
        }
      })();

    return {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      close(): Promise<void> {
        closed = true;
        if (wake) {
          const fn = wake;
          wake = null;
          fn();
        }
        return Promise.resolve();
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.tailClients].map(async (client) => {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
      }),
    );
    this.tailClients.clear();
    for (const subject of this.localBus.values()) {
      subject.complete();
    }
    this.localBus.clear();
    this.localBuffers.clear();
    this.localSequences.clear();
  }
}

/** XRANGE start 参数：'-' 或 '(<id>' 排他区间 */
type RedisStreamId = string;
