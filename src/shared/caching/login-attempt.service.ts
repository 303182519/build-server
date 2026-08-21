import { Inject, Injectable } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from './cache.tokens';
import { CacheKeys } from './cache.constants';
import { AUTH_LOCKOUT } from '@/common/constants/auth';


// Day 40：账号级登录锁定。和 Day 35 的限流（@Throttler，**按 IP**）正交——
//   限流挡「同一来源 IP 的洪泛」，锁定挡「针对同一账号的密码爆破」。
//   攻击者用一堆 IP（代理池）撞一个账号时，IP 限流逐个 IP 都没超阈值，
//   只有「账号维度」的计数能把这种爆破拦下来。
//
// 状态落在 Redis（一个带 TTL 的计数器 key），复用 Day 36/37 的「可选层」哲学：
//   Redis 连不上 → 整套锁定静默关闭，登录照常走（哪怕少了这层防护，也不让登录挂）。
//   这和存储选 S3 时的 fail-fast（Day 39 §6）刻意相反：锁定是「锦上添花的安全层」，
//   不是运营命脉，挂了宁可降级。
//
// 单 key 设计：auth:loginFail:email=<email> = 失败次数，首次失败时起算窗口（windowSec），
//   到期自动归零 → 账号自动解锁，无需人工介入、也不会永久误锁。成功登录立即 del 清零。

/** 一次失败计数的结果：当前累计次数、是否已触发锁定。 */
export interface AttemptResult {
  attempts: number;
  locked: boolean;
}

@Injectable()
export class LoginAttemptService {
  private readonly maxAttempts: number;
  private readonly windowSec: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClientType | null,
  ) {
    this.maxAttempts = AUTH_LOCKOUT.maxAttempts;
    this.windowSec = AUTH_LOCKOUT.lockMinutes * 60;
  }

  /**
   * 账号是否当前被锁。登录入口先问它：锁了就省掉 bcrypt 比对、直接拒（也省 CPU）。
   * Redis 不通恒返回 false（不锁）——降级。
   */
  async isLocked(email: string): Promise<boolean> {
    if (!this.redis) return false;
    const raw = await this.redis.get(CacheKeys.AUTH_LOGIN_FAIL(email));
    const n = Number(raw);
    // 判断一个值是不是整数，返回布尔值 `true / false`
    return Number.isInteger(n) && n >= this.maxAttempts;
  }

  /**
   * 记一次失败，返回是否刚好触发锁定。用 Lua 脚本保证「INCR + 首次起算窗口」的原子性
   * （仅当计数从 0→1 时设 EXPIRE，后续失败不重置窗口，避免滑动续期导致无限锁定的尾部效应）。
   */
  async recordFailure(email: string): Promise<AttemptResult> {
    if (!this.redis) return { attempts: 0, locked: false };
    const key = CacheKeys.AUTH_LOGIN_FAIL(email);

    // 功能：对 key 做自增；如果是第 1 次自增 (n=1)，才给这个 key 设置 TTL 过期时间；后续自增不重复设置过期。
    // 典型用途：接口限流，比如 “1 分钟最多 5 次请求”。
    const lua = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
      end
      return current
    `;
    const attempts = (await this.redis.eval(lua, {
      keys: [key],
      arguments: [String(this.windowSec)],
    })) as number;
    return { attempts, locked: attempts >= this.maxAttempts };
  }

  /**
   * 登录成功立即清零。这一点很关键：否则合法用户某次手滑输错几次后，
   * 计数器会在窗口内一直挂着，下次哪怕输对也快顶到阈值。成功即抹掉历史。
   */
  async clear(email: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(CacheKeys.AUTH_LOGIN_FAIL(email));
  }
}
