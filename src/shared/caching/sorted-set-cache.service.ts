import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { KeyPrefixer } from './cache.prefixer';
import { REDIS_CLIENT } from './cache.tokens';
import { withRedis } from './redis-fallback';

/**
 * Redis Sorted Set (ZSET) 命令的薄封装。
 *
 * ZSET 是 Redis 里最强大的有序数据结构：每个 member 关联一个 score，
 * 集合按 score 自动排序，支持原子加分（ZINCRBY）、按名次范围取（ZREVRANGE）、
 * 按 member 删（ZREM）、整体删（DEL）等操作。
 *
 * 典型场景：
 *   - 排行榜（热门内容、积分榜、Leaderboard）
 *   - 延时队列（score = 执行时间戳，轮询取 score ≤ now 的 member）
 *   - 滑动窗口限流（score = 请求时间戳，ZRANGEBYSCORE 计数）
 *
 * 设计原则与 HashCacheService / RedisLockService / LoginAttemptService 一致：
 *   1. 注入 REDIS_CLIENT（可能为 null，即 Redis 未配置）
 *   2. 所有 key 经 KeyPrefixer 统一加 namespace 前缀
 *   3. 所有操作经 withRedis() 统一降级：Redis 不可用时返回 fallback，不抛错
 *
 * 降级行为：Redis 为 null 或运行期故障时，
 *   - 写操作（zincrby / zrem / del）静默 no-op
 *   - 读操作（zrevrangeWithScores）返回 []
 *   调用方据此回退到 DB 旁路（如 PostsService.trending 回退到 ORDER BY view_count）。
 */
@Injectable()
export class SortedSetCacheService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
    private readonly prefixer: KeyPrefixer,
  ) {}

  /**
   * 原子加分。给指定 member 的 score += increment。
   * member 不存在时自动创建（score 从 0 起算），多实例并发安全。
   *
   * @param key ZSET 键名（走 CacheKeys 工厂）
   * @param increment 增量，可为负数（减分）
   * @param member 成员标识
   * @returns 加分后的新 score；Redis 不可用时返回 0
   *
   * @example
   * await sortedSet.zincrby(CacheKeys.TRENDING_POSTS, 1, '12345'); // 文章 12345 浏览 +1
   */
  async zincrby(
    key: string,
    increment: number,
    member: string,
  ): Promise<number> {
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.zIncrBy(redisKey, increment, member),
      0,
      'SortedSetCacheService.zincrby',
    );
  }

  /**
   * 移除成员。从 ZSET 中摘掉指定 member，不存在则静默忽略。
   *
   * @returns 实际移除的成员数；Redis 不可用时返回 0
   *
   * @example
   * await sortedSet.zrem(CacheKeys.TRENDING_POSTS, '12345'); // 文章被删，清榜
   */
  async zrem(key: string, member: string): Promise<number> {
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      (r) => r.zRem(redisKey, member),
      0,
      'SortedSetCacheService.zrem',
    );
  }

  /**
   * 按 score 从高到低取成员及分数。
   *
   * @param key ZSET 键名
   * @param start 起始索引（含），0 = 最高分
   * @param stop  结束索引（含），如 limit - 1
   * @returns [{ member, score }]，score 降序；Redis 不可用或榜为空时返回 []
   *
   * @example
   * // 取 Top 10
   * const top = await sortedSet.zrevrangeWithScores(CacheKeys.TRENDING_POSTS, 0, 9);
   */
  async zrevrangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const redisKey = this.prefixer.prefix(key);
    return withRedis(
      this.redis,
      async (r) => {
        // @redis/client v5：ZREVRANGE 合并进 ZRANGE，用 { REV: true } 实现倒序
        const rows = await r.zRangeWithScores(redisKey, start, stop, {
          REV: true,
        });
        // @redis/client v5 返回 { value: string, score: number }[]
        return rows.map((r) => ({ member: r.value, score: r.score }));
      },
      [],
      'SortedSetCacheService.zrevrangeWithScores',
    );
  }

  /**
   * 删除整个 ZSET key。
   *
   * @example
   * await sortedSet.del(CacheKeys.TRENDING_POSTS); // 仅测试用：清空榜单
   */
  async del(key: string): Promise<void> {
    const redisKey = this.prefixer.prefix(key);
    await withRedis(
      this.redis,
      async (r) => {
        await r.del(redisKey);
      },
      undefined,
      'SortedSetCacheService.del',
    );
  }
}
