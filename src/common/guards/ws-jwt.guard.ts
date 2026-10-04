import { extractWsToken } from '@/shared/utils/extract-token';
import { getConfig } from '@/config/configuration';
import { AuthSocket } from '@/modules/socket/interface/auth-socket';
import { JwtPayload } from '@/modules/auth/strategies/jwt-auth.strategy';
import { UserBasePayload, UsersService } from '@/modules/users/users.service';
import { CacheService } from '@/shared/caching/cache.service';
import { CacheKeys } from '@/shared/caching/cache.constants';
import {
  ErrorExceptionCode,
  ErrorExceptionMap,
} from '@/common/exceptions/error.exception';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';

/**
 * WS 用户存在性查询的缓存 TTL（秒）。
 *
 * 取舍：JWT 签名校验每条消息必做（无 DB），用户存在性（含软删检测）
 * 走 60s Redis 缓存。软删后最长 60s 生效，远小于 access token 15min
 * 过期窗口，安全可接受；单用户高频事件下 DB 查询从 msg_rate 降至 1/60s。
 * 软删时 UsersService.remove 会主动 DEL 该 key，进一步缩短生效延迟。
 */
const WS_USER_CACHE_TTL_SECONDS = 60;

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly cacheService: CacheService,
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
      // 用户存在性（含软删检测）走 60s Redis 缓存：高频 WS 消息下避免每条查库。
      // findOneOrThrow 在用户不存在/已软删时抛出 ErrorException(USER_NOT_FOUND)，
      // CacheService.wrap 的 loader 抛错不会写入缓存，下次仍会查库，保证
      // 软删用户不会被错误缓存为「存在」。
      // JWT 签名校验已在上方完成，此处缓存的是「该 sub 对应的用户仍存活」这一事实。
      const userId = BigInt(payload.sub);
      user = await this.cacheService.wrap<UserBasePayload>(
        CacheKeys.WS_AUTH_USER(userId.toString()),
        () => this.usersService.findOneOrThrow({ id: userId }),
        WS_USER_CACHE_TTL_SECONDS,
      );
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
