import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { BaseException } from '@/common/exceptions/base.exception';
import { createResponse } from '@/common/response/base.response';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { verify } from 'argon2';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenService } from './refresh-token.service';
import { LoginAttemptService } from '@/shared/caching/login-attempt.service';


// 登录时即使「用户不存在」也跑一次 argon2.verify，让响应耗时和「密码错」一致，
// 避免攻击者靠响应时间判断邮箱是否注册过（用户枚举 / 时序侧信道）。
// 这里硬编码一个预生成的合法 argon2 hash（参数与 UsersService.create 对齐：timeCost=5）。
// 值本身无意义，只要格式合法即可；argon2.verify 会走完整计算流程，满足常量时间要求。
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=5,p=4$c29tZXNhbHR0aGF0aXMxNmJ5dGVz$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// 登录查询时连带拉取的角色 + 权限载荷类型，与下方 findUnique 的 include 对齐。
// 单独抽出便于 toUserResponse / authResponse 共用，避免重复内联一长串 include 类型。
type UserWithRoles = Prisma.UserGetPayload<{
  include: {
    roles: {
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true };
            };
          };
        };
      };
    };
  };
}>;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly refreshTokenService: RefreshTokenService,
    // 账号级登录锁定（防密码爆破）。@Optional：LoginAttemptService 由全局 CacheModule
    // 提供，真实运行时恒在；标 @Optional 只为单元测试能 new AuthService 不传它。
    private readonly loginAttemptService: LoginAttemptService,
  ) {}

  async register(registerDto: RegisterDto) {
    return await this.usersService.create(registerDto); 
  }


  async login(dto: LoginDto) {
    // Day 40：账号级闸门——锁定优先于一切。已锁就省掉 bcrypt 比对（省 CPU），也避免再泄露信息。
    // Redis 不通时 isLocked 恒 false（降级），登录照常走，绝不被这层安全配置拖垮。
    if (await this.loginAttemptService.isLocked(dto.email)) {
      // 423 Locked（RFC 4918）：语义比 429/403 更准——账号被锁，不是「频率太快」也不是「没权限」。
      // HttpStatus 枚举里没有 423，用数字字面量（业务码 ACCOUNT_LOCKED 才是前端真正 key 的东西）。
      throw new ErrorException(ErrorExceptionCode.ACCOUNT_LOCKED);
    }

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: {
        roles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });
    // 用户不存在也比对一次（用废弃哈希），保持常量时间；任何失败都回同一个错误。
    // 注意：argon2.verify 在 hash 格式非法时会 throw（不是返回 false），
    // 必须 try-catch 吞掉异常，否则 DB 中损坏的 hash / 异常栈本身就是枚举信号。
    let ok = false;
    try {
      ok = await verify(dto.password, user?.password ?? DUMMY_HASH);
    } catch {
      ok = false;
    }
    if (!user || !ok) {
      // 记一次失败（达阈值即锁）。不区分「用户不存在 / 密码错」——都对同一 email 计数，
      // 否则「不存在的邮箱不计失败」这个差行为本身就成了枚举信号。
      await this.loginAttemptService.recordFailure(dto.email);
      throw new ErrorException(ErrorExceptionCode.INVALID_CREDENTIALS);
    }
    //成功即清零。否则用户偶发手滑几次后，计数器会在窗口内一直挂着顶到阈值。
    await this.loginAttemptService.clear(dto.email);
    return this.authResponse(user, await this.refreshTokenService.issue(user));
  }

  async logout(refreshToken: string) {
    await this.refreshTokenService.revoke(refreshToken);

    return createResponse({ success: true });
  }

  private authResponse(user: UserWithRoles, tokens: { refreshToken: string; accessToken: string; accessExpiresAt: number }) {
    return { ...tokens, user: this.toUserResponse(user) };
  }

  // ★ 出口统一脱敏：绝不把 password 带出去
  private toUserResponse(user: UserWithRoles) {
    const roles = user.roles.map((ur) => ({
      code: ur.role.code,
      name: ur.role.name,
    }));
    // 聚合去重：同一权限可能挂在多个角色下，前端只需唯一 code 集合
    const permissions = [
      ...new Set(
        user.roles.flatMap((ur) =>
          ur.role.rolePermissions.map((rp) => rp.permission.code),
        ),
      ),
    ];
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      roles,
      permissions,
      createdAt: user.createdAt,
    };
  }
}
