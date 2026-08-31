import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { CacheKeys } from '@/shared/caching/cache.constants';
import { randomBytes } from 'crypto';

// OAuth 登录完成后的「一次性取票凭证」。
//
// 为什么需要它：OAuth 回调是浏览器顶层导航到的地址，不能直接 return JSON（浏览器会把
// JSON 当页面渲染，前端 JS 没机会执行，token 也没人存）。所以回调里先把真正的 token 包
// 序列化进 Redis 换一张短时 ticket，302 跳到前端页只带 #ticket=xxx；前端再 fetch
// POST /auth/oauth/exchange 用 ticket 把真 token 换回来。
//
// 为什么 token 不直接放 URL fragment：URL 会落进浏览器历史 / 崩溃报告 / 扩展 / postMessage，
// access token 进 URL 泄露面大。ticket 一次性 + 60s TTL，即便泄露也作废。
//
// provider 无关：GitHub / 微信 / 微博 的回调都往这里塞 token 包，前端都走同一个 exchange 兑换。
// 加新 provider 不动本服务，也不动 exchange 接口。
//
// consume 用 Redis GETDEL（原子取并删）：并发/重放只有首个成功。
// Redis 不通时降级内存 Map（与 OAuthStateService / LoginAttemptService 同款哲学）。

const TICKET_TTL_SECONDS = 60; // 60s 够前端读 fragment + 发一次 fetch

interface FallbackEntry {
  payload: string;
  expiresAt: number;
}

@Injectable()
export class OAuthTicketService {
  private readonly fallback = new Map<string, FallbackEntry>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
  ) {}

  /** 存入 payload（调用方自己 JSON.stringify），返回一次性 ticket。 */
  async issue(payload: string): Promise<string> {
    const ticket = randomBytes(24).toString('base64url');
    if (this.redis) {
      await this.redis.set(CacheKeys.AUTH_OAUTH_TICKET(ticket), payload, {
        EX: TICKET_TTL_SECONDS,
      });
      return ticket;
    }
    this.fallback.set(ticket, {
      payload,
      expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000,
    });
    return ticket;
  }

  /** 一次性消费：存在且未过期就原子取并删，返回 payload；否则 null。 */
  async consume(ticket: string): Promise<string | null> {
    if (!ticket) return null;
    if (this.redis) {
      // GETDEL：原子"取值并删除"，null = 不存在/已删 → 兑换失败
      return this.redis.getDel(CacheKeys.AUTH_OAUTH_TICKET(ticket));
    }
    this.sweepFallback();
    const entry = this.fallback.get(ticket);
    if (!entry) return null;
    this.fallback.delete(ticket);
    if (entry.expiresAt <= Date.now()) return null; // 已过期，等同不存在
    return entry.payload;
  }

  private sweepFallback(): void {
    const now = Date.now();
    for (const [k, v] of this.fallback) {
      if (v.expiresAt <= now) this.fallback.delete(k);
    }
  }
}
