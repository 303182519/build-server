import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { CacheKeys } from '@/shared/caching/cache.constants';
import { randomBytes } from 'crypto';

// OAuth 授权码模式的 state（防 CSRF）一次性令牌存储。
//
// 为什么放 Redis（而不是进程内 Map）：
//   生产常多实例——发起登录落到 A 实例，GitHub 回调打到 B 实例，进程内 Map 取不到 → 登录必失败。
//   Redis 是共享存储，state 在哪个实例生成的都能被任意实例校验。
//
// 为什么 Redis 不通时降级到内存 Map（而不是直接 503）：
//   与 LoginAttemptService 同款哲学——state 是"锦上添花的 CSRF 防护"，不是运营命脉。
//   Redis 挂时宁可降级（仅单实例有效）也不让 GitHub 登录整体不可用。本地开发默认就这模式。
//
// consume 用 Redis GETDEL（原子取并删）：并发回调只有一个能拿到值，天然单次使用。
//   内存模式用 Map.delete，JS 单线程下也满足原子性。

const STATE_TTL_SECONDS = 600; // state 有效期 10 分钟：够用户在 GitHub 授权页磨蹭，又不会留太久

@Injectable()
export class OAuthStateService {
  // Redis 不通时的降级存储：Map<state, 过期时间戳(ms)>。每次 consume 前先清过期项，避免泄漏增长。
  private readonly fallback = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
  ) {}

  /** 生成一个新 state 并存储，返回原始值给客户端带去 GitHub。 */
  async generate(): Promise<string> {
    const state = randomBytes(16).toString('hex');
    if (this.redis) {
      // SET key value EX ttl：state 本身作为 value（不需要带额外载荷，存在即有效）
      await this.redis.set(
        CacheKeys.AUTH_OAUTH_STATE(state),
        '1',
        { EX: STATE_TTL_SECONDS },
      );
      return state;
    }
    this.fallback.set(state, Date.now() + STATE_TTL_SECONDS * 1000);
    return state;
  }

  /**
   * 一次性消费 state：存在且未过期就立即删除并返回 true，否则 false。
   * 原子性保证（Redis 用 GETDEL，内存用 delete）：并发回调只有首个成功，挡住重复回调与 CSRF。
   */
  async consume(state: string): Promise<boolean> {
    if (!state) return false;
    if (this.redis) {
      // GETDEL：原子地"取值并删除"。返回 null = 之前已删 / 从不存在 → 校验失败
      const raw = await this.redis.getDel(CacheKeys.AUTH_OAUTH_STATE(state));
      return raw !== null;
    }
    this.sweepFallback();
    return this.fallback.delete(state);
  }

  // 清扫过期项，避免 fallback Map 无限增长。O(n) 但本地开发场景量小，可接受。
  private sweepFallback(): void {
    const now = Date.now();
    for (const [k, expiresAt] of this.fallback) {
      if (expiresAt <= now) this.fallback.delete(k);
    }
  }
}
