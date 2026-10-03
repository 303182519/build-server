import { Logger } from '@nestjs/common';
import type { RedisConfig } from '@/config/configuration.interface';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Socket.IO Redis Adapter 专用 pub/sub 连接的注入 token。
 * 值为 null 表示未配置 Redis，Gateway 降级为单实例内存 adapter。
 */
export const SOCKET_IO_REDIS_CLIENTS = 'SOCKET_IO_REDIS_CLIENTS';

export interface SocketIoRedisClients {
  /** 发布连接：跨节点广播 / 请求均经此连接 PUBLISH */
  pubClient: Redis;
  /** 订阅连接：专用副本。Redis 订阅模式下连接不能再执行普通命令，必须与 pub 分离 */
  subClient: Redis;
  /** 适配器 pub/sub channel 前缀（多项目 / 多环境共用同一 Redis 时的隔离边界） */
  channelKey: string;
}

const logger = new Logger('SocketIoRedis');

/**
 * 构造 pub/sub 两个独立 Redis 连接。
 *
 * 设计约束：
 * 1. 复用项目既有 ioredis 依赖（与 BullMQ 一致）；@socket.io/redis-adapter
 *    同时兼容 node-redis 与 ioredis，此处走 ioredis 的 pmessageBuffer 分支。
 * 2. 不共享缓存模块的 REDIS_CLIENT：订阅连接会进入 subscriber 模式，
 *    无法再承担普通缓存命令；且缓存连接显式关闭了 offline queue，
 *    而适配器内部 `pubClient.publish()` 不 await 也不 catch，
 *    Redis 抖动期命令 reject 会升级为 unhandledRejection。
 * 3. pub/sub 是瞬态消息，保留 ioredis 默认 offline queue + 自动重连：
 *    抖动期命令排队、连接恢复后 subClient 自动重新订阅，广播不中断、不崩进程。
 *    重连退避封顶 3s，避免断线风暴。
 *
 * @returns 未配置 Redis（无 url 且无 host）时返回 null，由调用方降级单实例模式
 */
export const createSocketIoRedisClients = (
  redis: RedisConfig,
): SocketIoRedisClients | null => {
  const options: RedisOptions = {
    retryStrategy: (times: number) => Math.min(times * 200, 3_000),
  };

  let pubClient: Redis;
  if (redis.url) {
    // ioredis 原生支持 redis:// 与 rediss://（后者自动启用 TLS）
    pubClient = new Redis(redis.url, options);
  } else if (redis.host) {
    pubClient = new Redis({
      host: redis.host,
      port: redis.port ?? 6379,
      password: redis.password || undefined,
      db: redis.db ?? 0,
      ...options,
    });
  } else {
    return null;
  }

  // duplicate() 复制连接配置但不复制监听器，两个连接都必须各自挂 error handler：
  // EventEmitter 在无 error 监听器时默认 throw，会拖崩整个进程。
  pubClient.on('error', (err: unknown) => {
    logger.warn(
      `pub client error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const subClient = pubClient.duplicate();
  subClient.on('error', (err: unknown) => {
    logger.warn(
      `sub client error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return {
    pubClient,
    subClient,
    channelKey: `${redis.keyPrefix || 'my-first-nest'}:socket.io`,
  };
};

/** 应用关闭时优雅断开 pub/sub 连接；quit 失败不阻塞关闭流程。 */
export const closeSocketIoRedisClients = async (
  clients: SocketIoRedisClients,
): Promise<void> => {
  const results = await Promise.allSettled([
    clients.pubClient.quit(),
    clients.subClient.quit(),
  ]);
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn(
        `${index === 0 ? 'pub' : 'sub'} client quit failed: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
  });
};
