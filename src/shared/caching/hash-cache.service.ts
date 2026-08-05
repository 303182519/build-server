import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from './cache.tokens';

/**
 * Redis Hash 命令的薄封装。
 *
 * Redis Hash 可以理解为一个挂在单个 `key` 下的字符串字典：
 * ```
 * key: build:job:12345  ->  { status: "running", progress: "42", userId: "u_abc" }
 * ```
 * 适合存储"一条逻辑记录的多个字段"：可单字段读写、可整体取、可整体设 TTL，
 * 比把对象 JSON.stringify 进普通 string key 更灵活，更新单字段不会踩到其他字段。
 *
 * 降级行为：当 `redis` 为 null（未配置 Redis）时，所有方法静默返回空值
 * （读返回 null、`hincrby` 返回 0、写操作 no-op），不抛错。
 * 因此调用方需注意：`hget` 拿到 null 既可能是字段不存在，也可能是 Redis 未连接。
 */
@Injectable()
export class HashCacheService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
  ) {}

  /**
   * 写入单个 field。`value` 会被 `String(...)` 后存入（Redis 不区分数字/字符串）。
   *
   * @example
   * await hashCache.hset('build:job:12345', 'status', 'running');
   * await hashCache.hset('build:job:12345', 'progress', 42); // 存为 "42"
   */
  async hset(
    key: string,
    field: string,
    value: string | number,
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.hSet(key, field, String(value));
  }

  /**
   * 读取单个 field。不存在或 Redis 未连接时返回 null。
   *
   * @example
   * const status = await hashCache.hget('build:job:12345', 'status'); // "running"
   */
  async hget(key: string, field: string): Promise<string | null> {
    if (!this.redis) return null;
    return this.redis.hGet(key, field);
  }

  /**
   * 批量读取多个 field。返回顺序与入参 `fields` 一致；
   * 不存在的 field 在对应位置返回 null。一次往返省网络。
   *
   * @example
   * const [status, progress] = await hashCache.hmget(
   *   'build:job:12345',
   *   ['status', 'progress'],
   * ); // ["running", "42"]
   */
  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    if (fields.length === 0) return [];
    if (!this.redis) return fields.map(() => null);
    return this.redis.hmGet(key, fields);
  }

  /**
   * 取出整条 Hash 记录。Redis 未连接或 key 不存在时返回 `{}`。
   * 注意：大 Hash（字段极多）调用会一次性拉回全部数据，谨慎用于热路径。
   *
   * @example
   * const job = await hashCache.hgetall('build:job:12345');
   * // { status: "running", progress: "42", userId: "u_abc" }
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    if (!this.redis) return {};
    return this.redis.hGetAll(key);
  }

  /**
   * 删除一个或多个 field。返回实际删除的字段数。
   * 只删 field，不影响同 key 下的其他 field；要让整个 key 消失请用普通 `DEL key`。
   *
   * @example
   * await hashCache.hdel('build:job:12345', 'tempLog', 'debugFlag');
   */
  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    if (!this.redis) return 0;
    return this.redis.hDel(key, fields);
  }

  /**
   * 原子地给某个数字 field 增减。多个 worker 并发调用不会丢更新，
   * 是实现并发安全的"进度计数 / 计数器"的首选方式，禁止用"读出来 +N 再写回"替代。
   *
   * @example
   * await hashCache.hincrby('build:job:12345', 'progress', 5);  // 42 -> 47
   * await hashCache.hincrby('build:job:12345', 'progress', -1); // 47 -> 46
   */
  async hincrby(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    if (!this.redis) return 0;
    return this.redis.hIncrBy(key, field, increment);
  }

  /**
   * 给整个 key 设置过期时间（秒）。过期后整条 Hash 一起被 Redis 回收。
   * TTL 挂在 key 层级，无法对单个 field 单独设 TTL。
   * 续期：再次调用 `expire` 即可重置倒计时。
   *
   * @example
   * await hashCache.expire('build:job:12345', 7 * 24 * 3600); // 7 天后自动清理
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.expire(key, ttlSeconds);
  }
}
