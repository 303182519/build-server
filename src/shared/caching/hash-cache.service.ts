import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { KeyPrefixer } from './cache.prefixer';
import { REDIS_CLIENT } from './cache.tokens';
import { withRedis } from './redis-fallback';

/**
 * Redis Hash 命令的薄封装。
 *
 * Redis Hash 可以理解为一个挂在单个 `key` 下的字符串字典：
 * ```
 * build:job:12345  ->  { status: "running", progress: "42", userId: "u_abc" }
 * ```
 * 适合存储"一条逻辑记录的多个字段"：可单字段读写、可整体取、可整体设 TTL，
 * 比把对象 JSON.stringify 进普通 string key 更灵活，更新单字段不会踩到其他字段。
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Redis Cluster Hash Tag 规范（企业级）                        ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  仅当需要多 Key 批量操作（MGET / 事务 / Lua）时，才用         ║
 * ║  {业务域:业务id} 把同一实体的多个 key 聚到同一 Hash Slot。    ║
 * ║  单 key 场景（如本服务的单个 Hash）不要加 tag，让其自然散列。  ║
 * ║                                                              ║
 * ║  通用命名: {业务域}:{模块}:{资源类型}:{业务id}[:子标识]        ║
 * ║  Tag 格式: {业务域:业务id}:属性   （冒号分隔，全小写）        ║
 * ║                                                              ║
 * ║  ✅ 正确:  {user:123}:profile       (user 123 的资料)         ║
 * ║          {user:123}:permissions     (user 123 的权限)         ║
 * ║          → 两者 slot 相同，支持 MGET / 事务 / Lua              ║
 * ║          build:job:12345             (单 Hash，无 tag，自然散列)║
 * ║                                                              ║
 * ║  ❌ 错误: user:{id=123}:profile  (用 = 分隔，tag 仅含 id)     ║
 * ║          {all}:user:123          (全局共用 tag，槽倾斜)        ║
 * ║          user:123:expire_30d     (过期写进 key 名)             ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * 降级行为：当 `redis` 为 null（未配置 Redis）时，所有方法静默返回空值
 * （读返回 null、`hincrby` 返回 0、写操作 no-op），不抛错。
 * 因此调用方需注意：`hget` 拿到 null 既可能是字段不存在，也可能是 Redis 未连接。
 */
@Injectable()
export class HashCacheService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
    private readonly prefixer: KeyPrefixer,
  ) {}

  /**
   * 写入单个 field。Redis 协议层自动处理 number/string 类型转换。
   *
   * @example
   * await hashCache.hset('build:job:12345', 'status', 'running');
   * await hashCache.hset('build:job:12345', 'progress', 42);
   */
  async hset(
    key: string,
    field: string,
    value: string | number,
  ): Promise<void> {
    const redisKey = this.prefixer.prefix(key);
    await withRedis(
      this.redis,
      async (r) => {
        await r.hSet(redisKey, field, value);
      },
      undefined,
      'HashCacheService.hset',
    );
  }

  /**
   * 批量写入多个 field。一次往返省网络，适合初始化或整体更新整条 Hash。
   *
   * @param key Hash key（多 key 批量操作时带 Hash Tag，如 `{user:123}:profile`；单 key 无需 tag，如 `build:job:12345`）
   * @param mapping field-value 映射，value 支持 string / number
   * @param expire TTL 秒数，传入后通过 HSETEX 一次写入+设过期（Redis 6.2+）
   *
   * @example
   * // 只写数据
   * await hashCache.hmset('build:job:12345', {
   *   status: 'running',
   *   progress: 42,
   * });
   *
   * // 写入 + 7 天过期（一次往返）
   * await hashCache.hmset('build:job:12345', {
   *   status: 'running',
   *   progress: 42,
   * }, 7 * 24 * 3600);
   */
  async hmset(
    key: string,
    mapping: Record<string, string | number>,
    expire?: number,
  ): Promise<void> {
    const redisKey = this.prefixer.prefix(key);
    await withRedis(
      this.redis,
      async (r) => {
        if (expire !== undefined) {
          await r.hSetEx(redisKey, mapping, {
            expiration: { type: 'EX', value: expire },
          });
        } else {
          await r.hSet(redisKey, mapping);
        }
      },
      undefined,
      'HashCacheService.hmset',
    );
  }

  /**
   * 读取单个 field。不存在或 Redis 未连接时返回 null。
   *
   * @example
   * const status = await hashCache.hget('build:job:12345', 'status'); // "running"
   */
  async hget(key: string, field: string): Promise<string | null> {
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.hGet(redisKey, field) as Promise<string | null>,
      null,
      'HashCacheService.hget',
    );
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
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.hmGet(redisKey, fields) as Promise<(string | null)[]>,
      fields.map(() => null),
      'HashCacheService.hmget',
    );
  }

  /**
   * 取出整条 Hash 记录。Redis 未连接或 key 不存在时返回 `{}`。
   * 注意：大 Hash（字段极多）调用会一次性拉回全部数据，谨慎用于热路径。
   *
   * @example
   * const job = await hashCache.hgetall('build:job:12345');
   * // { status: "running", progress: "42" }
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.hGetAll(redisKey) as Promise<Record<string, string>>,
      {},
      'HashCacheService.hgetall',
    );
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
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.hDel(redisKey, fields),
      0,
      'HashCacheService.hdel',
    );
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
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.hIncrBy(redisKey, field, increment),
      0,
      'HashCacheService.hincrby',
    );
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
    const redisKey = this.prefixer.prefix(key);
    await withRedis(
      this.redis,
      async (r) => {
        await r.expire(redisKey, ttlSeconds);
      },
      undefined,
      'HashCacheService.expire',
    );
  }
}
