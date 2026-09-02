import { useRequestUser } from '@/common/context/user-context';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthRequest } from '@/types/express';

/**
 * 自定义限流守卫。
 *
 * 默认按 IP 限流。如果有登录用户，则按 userId 限流。
 * 这样登录用户有独立的配额，不会被同一 IP 下的其他用户影响。
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  /**
   * tracker 前缀：user:{userId} 或 ip:{ip}。
   * 完整 key 组装链路（经过三层）：
   *   1. 本 getTracker → "user:abc123" / "ip:1.2.3.4"
   *   2. throttler.module 的 readableGenerateKey → "AuthController-login-default-user:abc123"
   *   3. RedisThrottlerStorage.increment → "throttle:block:default:AuthController-login-default-user:abc123"
   */
  private static readonly TRACKER_USER_PREFIX = 'user:';
  private static readonly TRACKER_IP_PREFIX = 'ip:';

  protected getTracker(req: AuthRequest): Promise<string> {
    const userId = this.getUserId(req);

    if (userId) {
      return Promise.resolve(`${AppThrottlerGuard.TRACKER_USER_PREFIX}${userId}`);
    }
    return Promise.resolve(`${AppThrottlerGuard.TRACKER_IP_PREFIX}${req.ips[0] || req.ip}`);
  }

  private getUserId(req: AuthRequest): string | undefined {
    try {
      return useRequestUser().id.toString();
    } catch {
      return req.user?.id.toString();
    }
  }
}
