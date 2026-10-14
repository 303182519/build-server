import { RequestContextService } from '@/common/context/request-context.service';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { AuthRequest } from '@/types/express';
import type { AuthSocket } from '@/modules/socket/interface/auth-socket';

/**
 * 自定义限流守卫。
 *
 * 默认按 IP 限流。如果有登录用户，则按 userId 限流。
 * 这样登录用户有独立的配额，不会被同一 IP 下的其他用户影响。
 *
 * 同时兼容 HTTP 与 WebSocket 上下文：
 * - HTTP：req 为 Express.Request，取 requestContext.requireUser / req.user / req.ips / req.ip；
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

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    // 请求上下文门面（ADR-005）：Guard 阶段可访问 CLS（由 ClsMiddleware 建立），
    // 用于按用户限流。需显式转发前三个参数给 ThrottlerGuard，否则基类配置丢失、限流失效。
    private readonly requestContext: RequestContextService,
  ) {
    super(options, storageService, reflector);
  }

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
      // requireUser 基于请求上下文（CLS），仅 HTTP 请求生命周期内可用。
      return this.requestContext.requireUser().id.toString();
    } catch {
      // WS 上下文：client.user 在 WsJwtGuard.authenticateClient 中挂载。
      return req.user?.id.toString();
    }
  }
}
