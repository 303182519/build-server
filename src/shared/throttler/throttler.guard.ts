// import { useRequestUser } from '@/common/context/user-context';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
// import type { AuthRequest } from '@/types/express';

/**
 * 自定义限流守卫。
 *
 * 默认按 IP 限流。如果有登录用户，则按 userId 限流。
 * 这样登录用户有独立的配额，不会被同一 IP 下的其他用户影响。
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    // const userId = this.getUserId(req);

    // if (userId) {
    //   return Promise.resolve(`user:${userId}`);
    // }
    console.log('ip', req.ip);
    console.log('ips[0]', req.ips);
    return Promise.resolve(`ip:${req.ips[0] || req.ip}`);
  }

  // private getUserId(req: AuthRequest): string | undefined {
  //   try {
  //     return useRequestUser().id;
  //   } catch {
  //     return req.user?.id;
  //   }
  // }
}
