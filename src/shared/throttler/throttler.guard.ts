import { useRequestUser } from '@/common/context/user-context';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthRequest } from '@/types/express';
import type { AuthSocket } from '@/modules/socket/interface/auth-socket';

/**
 * 自定义限流守卫。
 *
 * 默认按 IP 限流。如果有登录用户，则按 userId 限流。
 * 这样登录用户有独立的配额，不会被同一 IP 下的其他用户影响。
 *
 * 同时兼容 HTTP 与 WebSocket 上下文：
 * - HTTP：req 为 Express.Request，取 useRequestUser / req.user / req.ips / req.ip；
 * - WS：req 为 Socket 实例，取 client.user / handshake.address。
 * 全局 APP_GUARD 会对 @SubscribeMessage 生效，因此必须处理 WS 形状，
 * 否则 req.ips[0] 会在 WS 消息上抛出 TypeError。
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

  protected getTracker(req: AuthRequest | AuthSocket): Promise<string> {
    const userId = this.getUserId(req);
    if (userId) {
      return Promise.resolve(
        `${AppThrottlerGuard.TRACKER_USER_PREFIX}${userId}`,
      );
    }

    // WebSocket 上下文：req 为 Socket，无 ips/ip，取握手地址。
    const socket = req as AuthSocket;
    if (socket.handshake) {
      const ip =
        socket.handshake.address || socket.conn?.remoteAddress || 'unknown';
      return Promise.resolve(`${AppThrottlerGuard.TRACKER_IP_PREFIX}${ip}`);
    }

    // HTTP 上下文
    const httpReq = req as AuthRequest;
    return Promise.resolve(
      `${AppThrottlerGuard.TRACKER_IP_PREFIX}${httpReq.ips?.[0] || httpReq.ip}`,
    );
  }

  private getUserId(req: AuthRequest | AuthSocket): string | undefined {
    try {
      // useRequestUser 基于 AsyncLocalStorage，仅 HTTP 请求生命周期内可用。
      return useRequestUser().id.toString();
    } catch {
      // WS 上下文：client.user 在 WsJwtGuard.authenticateClient 中挂载。
      return req.user?.id.toString();
    }
  }
}
