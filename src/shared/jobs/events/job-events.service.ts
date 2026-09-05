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
import { IJobSseEvent } from '../types/job.types';

/**
 * 任务事件广播层。
 *
 * 多实例部署时，单进程内的 RxJS Subject 无法跨进程广播：
 * 实例 A 发布的 Job 事件，实例 B 上的 SSE 订阅者收不到。
 *
 * 解决方案：Redis Pub/Sub
 *   - Redis 可用：publish → Redis PUBLISH → 所有实例的 subscriber 收到 → 推入本地 Subject
 *   - Redis 不可用：publish → 直接推入本地 Subject（降级为单实例模式）
 *
 * 对外 API（publish / subscribe）不变，调用方无需感知底层传输。
 *
 * 注意：Redis Pub/Sub 是 fire-and-forget，sub 断连期间的消息会丢失。
 * 配合 SSE snapshot 机制（连接时先推一次当前状态快照）可缓解此问题。
 */
@Injectable()
export class JobEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(JobEventsService.name);

  /** 进程内事件总线：所有 SSE 订阅者通过此 Subject 接收事件 */
  private readonly events$ = new Subject<IJobSseEvent>();
  private sequence = 0;

  /** Redis Pub/Sub 发布者（独立连接） */
  private pubClient: RedisClientType | null = null;
  /** Redis Pub/Sub 订阅者（独立连接；Redis 要求 sub 端独占连接） */
  private subClient: RedisClientType | null = null;

  /** Redis Pub/Sub 频道名 */
  private readonly channel: string;

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: RedisClientType | null,
    private readonly prefixer: KeyPrefixer,
  ) {
    this.channel = this.prefixer.prefix('job:events');

    if (this.redis) {
      this.initRedisPubSub().catch((err) => {
        this.logger.warn(
          `Redis Pub/Sub 初始化失败，降级为进程内事件: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.pubClient = null;
        this.subClient = null;
      });
    } else {
      this.logger.log('Redis 未配置，Job 事件仅在单实例内广播');
    }
  }

  /**
   * 初始化 Redis Pub/Sub 双连接。
   *
   * Redis 协议要求进入 subscriber 模式的连接不能再执行其他命令，
   * 因此需要两个独立连接：一个用于 PUBLISH，一个用于 SUBSCRIBE。
   */
  private async initRedisPubSub(): Promise<void> {
    // duplicate() 复用相同连接配置，创建独立的新连接
    this.pubClient = this.redis!.duplicate();
    this.subClient = this.redis!.duplicate();

    // 关闭离线队列：连接断开时命令立即 reject，而非挂入队列无限等待重连
    if (this.pubClient.options)
      this.pubClient.options.disableOfflineQueue = true;
    if (this.subClient.options)
      this.subClient.options.disableOfflineQueue = true;

    await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

    // subscriber 端监听频道消息，反序列化后推入本地 Subject
    await this.subClient.subscribe(this.channel, (rawMessage: string) => {
      try {
        const event = JSON.parse(rawMessage) as IJobSseEvent;
        this.events$.next(event);
      } catch (err) {
        this.logger.warn(
          `Redis Pub/Sub 消息解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.logger.log(`Redis Pub/Sub 已连接 (channel=${this.channel})`);
  }

  /**
   * 发布一个 Job 事件。
   *
   * - Redis 可用：通过 Redis PUBLISH 广播给所有实例（本实例的 sub 也会收到，统一推入 Subject）
   * - Redis 不可用：直接推入本地 Subject（仅本实例可见）
   */
  publish(event: Omit<IJobSseEvent, 'id'>): IJobSseEvent {
    const nextEvent: IJobSseEvent = {
      ...event,
      id: String(++this.sequence),
    };

    if (this.pubClient) {
      // Redis 可用：走 Redis Pub/Sub 广播，本实例的 subscriber 收到后会推入 events$
      this.pubClient
        .publish(this.channel, JSON.stringify(nextEvent))
        .catch((err) => {
          this.logger.warn(
            `Redis PUBLISH 失败，事件丢失: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      // Redis 不可用：降级为进程内广播
      this.events$.next(nextEvent);
    }

    return nextEvent;
  }

  /**
   * 订阅指定 Job 的事件流。
   *
   * 返回一个 Observable，内部从 events$ Subject 按 jobId 过滤。
   * 无论事件来源是本地 publish 还是 Redis 远端 publish，订阅者都能收到。
   */
  subscribe(jobId: string): Observable<IJobSseEvent> {
    return this.events$.asObservable().pipe(
      filter((event) => {
        return event.data.id === jobId;
      }),
    );
  }

  /** 模块销毁时清理 Redis 连接 */
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
