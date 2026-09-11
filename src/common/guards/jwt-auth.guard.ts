import { User } from '@prisma/client';
import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { JWT_META_KEY } from '../decorators/jwt-auth.decorator';
import { AuthExceptionCode } from '../exceptions/auth.exception';
import { ErrorException } from '../exceptions/error.exception';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext, // https://docs.nestjs.cn/fundamentals/execution-context#executioncontext-%E7%B1%BB
  ): boolean | Promise<boolean> | Observable<boolean> {
    // 跳过 WebSocket 上下文，由 WsJwtGuard 处理
    if (context.getType() === 'ws') {
      return true;
    }

    const jwtMeta = this.reflector.getAllAndOverride<boolean>(JWT_META_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (jwtMeta) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser = User>(
    err: any,
    user: User | undefined,
    info: any,
    // context: ExecutionContext,
    // status?: any,
  ): TUser {
    // 只记录判定所需的最小信息，避免把 token / 原始错误对象打进日志
    this.logger.debug('JWT 认证结果', {
      hasError: Boolean(err),
      username: user?.username,
      infoName:
        info instanceof Error ? info.name : info ? String(info) : undefined,
    });

    if (err) {
      throw err;
    }

    if (!user) {
      // token 校验失败时，info 为 jsonwebtoken 的错误对象（TokenExpiredError / JsonWebTokenError）
      // 或 'No auth token' 等字符串，原样透出会是英文 message，
      // 因此按错误类型映射为中文业务异常，同时携带 MMSNN 业务码供前端精确分流
      if (info instanceof Error && info.name === 'TokenExpiredError') {
        throw new ErrorException(AuthExceptionCode.ACCESS_TOKEN_EXPIRED);
      }
      throw new ErrorException(AuthExceptionCode.INVALID_ACCESS_TOKEN);
    }

    return user as TUser;
  }
}
