import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { randomBytes } from 'crypto';
import { KeyPrefixer } from './cache.prefixer';
import { REDIS_CLIENT } from './cache.tokens';
import { withRedis } from './redis-fallback';

/**
 * RedisLockService —— 基于 `SET NX EX` + Lua 安全释放的分布式锁。
 *
 * 为什么需要分布式锁：进程内的锁（Mutex / 我们的 coalesce）只在「一个进程」里有效。
 * 生产部署通常是多实例（多 Pod），每个进程各自一把内存锁，根本互不可见——同一个 key
 * 的并发请求会被 N 个实例各放一个过去。要「全集群只放一个」，锁必须放在所有实例都看得到
 * 的地方：Redis。
 *
 * 这把锁的正确性靠三件事，缺一不可：
 *
 * 1. **抢锁原子**：`SET key token NX EX ttl` 一条命令同时做到「不存在才写」+「设过期」。
 *    不能拆成「先 GET 再 SET」——两步之间有窗口，会两人都抢到。
 *
 * 2. **必带 TTL**：持锁进程如果崩溃，没来得及释放，锁要能自动过期，否则后续所有人都永远抢不到
 *    （「锁死了」）。EX 就是这道保险。代价是：TTL 内若任务没跑完，锁会提前释放、被别人抢走——
 *    所以 TTL 要略大于「最慢一次临界区执行」，且临界区要尽量短。
 *
 * 3. **释放要「只删自己的」**：用 token（随机串）标记「这把锁是我抢的」。释放时必须「比对 token
 *    相等才删」。关键：比对和删除必须原子——不能先 GET 比对再 DEL，否则中间锁过期、被别人
 *    重新抢走，你这一删就把别人的锁删了。用 Lua 脚本（Redis 单条脚本原子执行）一气呵成。
 *
 * 这把锁用在缓存击穿（thundering herd）的「分布式重建」上：同一个 key 全集群只让一个实例查库
 * 回填，其余实例排队等缓存（见 PostsService.rebuildUnderLock）。
 *
 * 降级行为：Redis 不通时 `acquire` 恒返回 null（没抢到），调用方按「未抢到」分支处理——
 * 通常是跳过回源、等下次缓存 miss 自然重试。这和 LoginAttemptService / OAuthStateService
 * 的「锦上添花层降级」哲学一致：分布式锁挡的是「优化」而非「正确性」——少了它大不了多查几次
 * 库，不能让 Redis 一挂业务就挂。但绝不能在 Redis 不通时假装抢到锁（返回非空 token），
 * 否则集群里每个实例都以为自己是「那一个」，分布式锁形同虚设。
 */
@Injectable()
export class RedisLockService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
    private readonly prefixer: KeyPrefixer,
  ) {}

  /**
   * 抢锁。成功返回 token（释放时必须原样带回），失败返回 null。
   *
   * token 用 `crypto.randomBytes(16)` 生成 32 位 hex——足够长的随机串保证「我抢的锁」
   * 不会被别的实例冒认。不要用时间戳、自增 ID 这类可预测值，否则释放时的 token 比对形同虚设。
   *
   * @param key 锁名（建议走 CacheKeys 工厂，与其他业务 key 同源命名）
   * @param ttlSeconds 锁过期时间。必须略大于「最慢一次临界区执行」，否则任务没跑完锁就被别人抢走
   */
  async acquire(key: string, ttlSeconds: number): Promise<string | null> {
    const redisKey = this.prefixer.prefix(key);
    const token = randomBytes(16).toString('hex');
    return withRedis(
      this.redis,
      async (r) => {
        // SET key token NX EX ttl：一条命令同时完成「不存在才写」+「设过期」，原子无窗口
        const result = await r.set(redisKey, token, {
          NX: true,
          EX: ttlSeconds,
        });
        return result === 'OK' ? token : null;
      },
      // Redis 不通（未配置或断连）：按"没抢到"降级，让调用方走旁路。
      // 绝不能返回非空 token——那会让集群里每个实例都以为自己是"那一个"。
      null,
      'RedisLockService.acquire',
    );
  }

  /**
   * 释放锁。仅当 key 当前持有的 token 与入参一致才删除——「只删自己的」。
   *
   * 比对 + 删除必须原子：若拆成「GET 比对 → DEL」两步，中间锁 TTL 到期被别人重新抢走，
   * 你这一删就把别人的锁删了，临界区里就跑进了两个实例。用 Lua 脚本让 Redis 单线程
   * 一次执行完「比对 + 删除」，没有窗口。
   *
   * @returns true=我释放成功；false=锁已不归我管（TTL 已过被别人抢走 / 我从未持有 / Redis 不通）
   *
   * 调用方对 false 的处理：通常忽略——「锁过期了」是 SET NX EX 模式的预期风险，不是错误。
   * 真要排查可记日志，但不要抛错（临界区该跑的已经跑了，抛错反而让事务回滚更乱）。
   */
  async release(key: string, token: string): Promise<boolean> {
    const redisKey = this.prefixer.prefix(key);
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `;
    return withRedis(
      this.redis,
      async (r) => {
        const result = (await r.eval(lua, {
          keys: [redisKey],
          arguments: [token],
        })) as number;
        return result === 1;
      },
      // 释放失败（锁已易主 / Redis 不通）忽略——是 SET NX EX 模式的预期风险，不能污染 fn 的返回/异常
      false,
      'RedisLockService.release',
    );
  }

  /**
   * 抢锁 → 执行 fn → 释放（finally 保证释放）。抢不到返回 undefined，调用方据此降级。
   * 用它把「临界区」包起来最省心：拿不到锁不会傻等，直接降级走旁路。
   *
   * @example
   * const result = await this.locks.withLock(CacheKeys.LOCK_REBUILD(id), 10, () =>
   *   this.rebuildFromDb(id),
   * );
   * if (result === undefined) return; // 没抢到锁：别的实例正在重建，降级走旁路
   *
   * 注意：undefined 只代表「没抢到锁」；fn 内部的失败会原样抛出，不被这里吞掉。
   * 因此 fn 的正常返回值不应该是 undefined，否则调用方无法区分「抢锁失败」和「fn 返回了 undefined」。
   */
  async withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const token = await this.acquire(key, ttlSeconds);
    if (token === null) return undefined;
    try {
      return await fn();
    } finally {
      // 无论 fn 成功还是抛错都要释放，否则只能等 TTL 过期。释放失败（锁已易主）忽略。
      await this.release(key, token);
    }
  }
}
