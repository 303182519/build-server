import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { KeyPrefixer } from '@/shared/caching/cache.prefixer';
import { IAgentSseEvent } from './agent.types';

/**
 * Agent 审批事件广播层。
 *
 * 与 JobEventsService 同构：
 *   - Redis 可用：publish → Redis PUBLISH → 所有实例的 subscriber 收到 → 推入本地 Subject
 *   - Redis 不可用：直接推入本地 Subject（降级为单实例模式）
 *
 * Redis Pub/Sub 是 fire-and-forget，断连期间消息丢失；配合 SSE snapshot 机制兜底。
 */
@Injectable()
export class AgentEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentEventsService.name);

  private readonly events$ = new Subject<IAgentSseEvent>();
  private sequence = 0;

  private pubClient: RedisClientType | null = null;
  private subClient: RedisClientType | null = null;

  private readonly channel: string;

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: RedisClientType | null,
    private readonly prefixer: KeyPrefixer,
  ) {
    this.channel = this.prefixer.prefix('agent:events');

    if (this.redis) {
      this.initRedisPubSub().catch((err) => {
        this.logger.warn(
          `Redis Pub/Sub 初始化失败，降级为进程内事件: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.pubClient = null;
        this.subClient = null;
      });
    } else {
      this.logger.log('Redis 未配置，Agent 事件仅在单实例内广播');
    }
  }

  private async initRedisPubSub(): Promise<void> {
    this.pubClient = this.redis!.duplicate();
    this.subClient = this.redis!.duplicate();

    if (this.pubClient.options)
      this.pubClient.options.disableOfflineQueue = true;
    if (this.subClient.options)
      this.subClient.options.disableOfflineQueue = true;

    this.pubClient.on('error', (err: unknown) => {
      this.logger.warn(
        `Redis pub client error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.subClient.on('error', (err: unknown) => {
      this.logger.warn(
        `Redis sub client error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

    await this.subClient.subscribe(this.channel, (rawMessage: string) => {
      try {
        const event = JSON.parse(rawMessage) as IAgentSseEvent;
        this.events$.next(event);
      } catch (err) {
        this.logger.warn(
          `Redis Pub/Sub 消息解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.logger.log(`Redis Pub/Sub 已连接 (channel=${this.channel})`);
  }

  publish(event: Omit<IAgentSseEvent, 'id'>): IAgentSseEvent {
    const nextEvent: IAgentSseEvent = {
      ...event,
      id: String(++this.sequence),
    };

    if (this.pubClient) {
      this.pubClient
        .publish(this.channel, JSON.stringify(nextEvent))
        .catch((err) => {
          this.logger.warn(
            `Redis PUBLISH 失败，事件丢失: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      this.events$.next(nextEvent);
    }

    return nextEvent;
  }

  /**
   * 订阅指定 Agent 运行的事件流。
   * 入参必须是 runId（agent_approvals.id，对应 SSE 路由 /runs/:id/events 的 :id），
   * 按 event.data.id 过滤；不能用 threadId——runId 与 threadId 是两个不同的 snowflake。
   */
  subscribe(runId: string): Observable<IAgentSseEvent> {
    return this.events$
      .asObservable()
      .pipe(filter((event) => event.data.id === runId));
  }

  async onModuleDestroy(): Promise<void> {
    const clients: (RedisClientType | null)[] = [
      this.pubClient,
      this.subClient,
    ];
    for (const client of clients) {
      if (!client) continue;
      try {
        if (client === this.subClient) {
          await client.unsubscribe(this.channel);
        }
        await client.quit();
      } catch (err) {
        this.logger.warn(
          `Redis Pub/Sub 连接关闭异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.pubClient = null;
    this.subClient = null;
    this.events$.complete();
  }
}
