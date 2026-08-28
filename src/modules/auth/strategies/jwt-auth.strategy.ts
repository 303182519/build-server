/**
 * 后端收到请求头里的 token 后，自动解析、校验签名、提取用户信息
 */

import { getConfig } from '@/config/configuration';
import { UsersService } from '@/modules/users/users.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
}

@Injectable()
export class JwtAuthStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    protected configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      // 【重点】从请求Header提取token：格式 Bearer xxxxxx
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 是否忽略过期校验，false=自动校验token过期，过期直接401
      ignoreExpiration: false,
      secretOrKey: getConfig(configService).jwt.secret,
    });
  }
  /**
   * token校验通过后自动执行此方法
   * payload = jwt解码后的内容（你登录时存入的数据）
   * return 的对象 会挂载到 req.user
   */
  async validate(payload: JwtPayload) {

    // payload 就是登录签发token时传入的数据，例如 { sub: userId, username:xxx }
    // 这里你可以查询数据库，验证用户是否存在、是否被禁用。
    // findOneOrThrow 在用户不存在/已软删时已抛 USER_NOT_FOUND，无需再判空。
    return this.usersService.findOneOrThrow({ id: BigInt(payload.sub) });
  }
}
