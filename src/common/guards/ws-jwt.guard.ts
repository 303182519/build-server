import { extractWsToken } from '@/shared/utils/extract-token';
import { getConfig } from '@/config/configuration';
import { AuthSocket } from '@/modules/socket/interface/auth-socket';
import { JwtPayload } from '@/modules/auth/strategies/jwt-auth.strategy';
import { UsersService } from '@/modules/users/users.service';
import {
  ErrorExceptionCode,
  ErrorExceptionMap,
} from '@/common/exceptions/error.exception';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<AuthSocket>();
    const token = extractWsToken(client);

    if (!token) {
      this.throwWsException(ErrorExceptionCode.INVALID_ACCESS_TOKEN);
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token, {
        secret: getConfig(this.configService).jwt.secret,
      });
    } catch (err) {
      const code =
        err instanceof Error && err.name === 'TokenExpiredError'
          ? ErrorExceptionCode.ACCESS_TOKEN_EXPIRED
          : ErrorExceptionCode.INVALID_ACCESS_TOKEN;
      this.throwWsException(code);
    }

    // findOneOrThrow 在用户不存在/已软删时抛出 ErrorException(USER_NOT_FOUND)，
    // 交由 WsExceptionFilter 统一捕获并通过 exception 事件下发客户端。
    const user = await this.usersService.findOneOrThrow({
      id: BigInt(payload.sub),
    });

    // user 类型为 UserWithFlatRoles | UserBasePayload，
    // AuthSocket.user 为 UserBasePayload，二者结构兼容可直接赋值。
    client.user = user;
    return true;
  }

  /**
   * 从 ExceptionMap 取错误信息并包装为 WsException，确保 WsExceptionFilter 能捕获并通过
   * exception 事件下发给客户端。响应体使用 status 字段以兼容前端 error.status === 401 判断。
   */
  private throwWsException(code: ErrorExceptionCode): never {
    const info = ErrorExceptionMap[code];
    throw new WsException({
      status: info.status,
      message: info.message,
      code: info.code,
    });
  }
}
