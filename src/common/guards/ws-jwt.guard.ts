import { extractWsToken } from '@/shared/utils/extract-token';
import { getConfig } from '@/config/configuration';
import { AuthSocket } from '@/modules/socket/interface/auth-socket';
import { JwtPayload } from '@/modules/auth/strategies/jwt-auth.strategy';
import { UserBasePayload, UsersService } from '@/modules/users/users.service';
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
    await this.authenticateClient(client);
    return true;
  }

  /**
   * 统一的 WS 鉴权入口：提取 token → 校验 JWT → 查询用户 → 挂载 client.user。
   *
   * 由于 @UseGuards 对 handleConnection 生命周期不生效，连接阶段与消息管道
   * 都需要鉴权。此方法作为单一事实源被两处复用，避免重复实现，并保证所有失败
   * 场景统一走 ExceptionMap（INVALID_ACCESS_TOKEN / ACCESS_TOKEN_EXPIRED /
   * USER_NOT_FOUND）。
   *
   * 失败时抛出 WsException：
   * - 在 @SubscribeMessage 消息管道中由 WsExceptionFilter 捕获并下发 exception 事件；
   * - 在 handleConnection 中由调用方捕获后，emit('exception') 再断开连接。
   */
  async authenticateClient(client: AuthSocket): Promise<UserBasePayload> {
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

    let user: UserBasePayload;
    try {
      // findOneOrThrow 在用户不存在/已软删时抛出 ErrorException(USER_NOT_FOUND)，
      // 统一包装为 WsException，便于消息管道与连接阶段一致处理。
      user = await this.usersService.findOneOrThrow({
        id: BigInt(payload.sub),
      });
    } catch {
      this.throwWsException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    // user 类型为 UserWithFlatRoles | UserBasePayload，
    // AuthSocket.user 为 UserBasePayload，二者结构兼容可直接赋值。
    client.user = user;
    return user;
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
