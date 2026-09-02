import { Injectable } from '@nestjs/common';
import { SortedSetCacheService } from '@/shared/caching/sorted-set-cache.service';
import { CacheKeys } from '@/shared/caching/cache.constants';

/**
 * TrendingService —— 用 Redis Sorted Set 维护「热门文章排行榜」。
 *
 * 为什么用 ZSET 而不是在数据库里 ORDER BY view_count：
 *   - 排行榜是「写极频繁」（每次浏览都加分）+「读要按名次取 Top N」的组合。
 *     ZSET 的 ZINCRBY 是原子加分、ZRANGE REV 是 O(log N + N) 取前 N，全在内存里，
 *     比每次都 `ORDER BY view_count DESC LIMIT N`（要全表排序 / 靠索引）快得多、对 DB 零压力。
 *   - 这是 Redis「数据结构服务器」价值的典型体现：把「高频写 + 排序取」下推成两条原子命令。
 *
 * 分数怎么定义：这里用最朴素的「累计浏览数」（每次浏览 ZINCRBY +1）。
 *   真实「热门」通常要时间衰减（让新内容有机会上榜、老内容淡出），比如 score = Σ 浏览 × 衰减因子，
 *   或定期把旧分数衰减。当前用累计浏览数足够讲清 ZSET；后续可按需引入时间衰减策略。
 *
 * ★ 降级哲学：Redis 挂了排行榜就退化成「直查 DB 取 Top N」，绝不让接口挂掉。
 *   降级由调用方（PostsService.trending）根据返回的 [] 判断并回退。
 *
 * 架构说明：ZSET 的底层 Redis 操作封装在 SortedSetCacheService（共享基础设施层），
 *   本服务只关注「排行榜」这一业务语义。SortedSetCacheService 可被其他模块复用
 *   （延时队列、积分榜等），符合单一职责与 DRY 原则。
 */
@Injectable()
export class TrendingService {
  constructor(private readonly sortedSet: SortedSetCacheService) {}

  /** 某文章浏览 +1 → 给它在榜上的分数 +1。原子，多实例并发安全。 */
  async bump(postId: string): Promise<void> {
    // SortedSetCacheService 内部 via withRedis() 统一降级：Redis 不通静默 no-op
    await this.sortedSet.zincrby(CacheKeys.TRENDING_POSTS, 1, postId);
  }

  /** 某文章被删 → 从榜上摘掉，免得排行榜里挂着已删除的 id。 */
  async drop(postId: string): Promise<void> {
    await this.sortedSet.zrem(CacheKeys.TRENDING_POSTS, postId);
  }

  /**
   * 取 Top N。返回 [{ id, score }]，分数从高到低。
   * Redis 不可用、或榜为空（还没人浏览过）→ 返回 []，调用方据此回退到「DB 按 view_count 取」。
   */
  async top(limit: number): Promise<Array<{ id: string; score: number }>> {
    const rows = await this.sortedSet.zrevrangeWithScores(
      CacheKeys.TRENDING_POSTS,
      0,
      Math.max(0, limit - 1),
    );
    return rows.map((r) => ({ id: r.member, score: r.score }));
  }

  /** 仅测试用：清空榜单。 */
  async reset(): Promise<void> {
    await this.sortedSet.del(CacheKeys.TRENDING_POSTS);
  }
}
