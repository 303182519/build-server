import { TokenType } from '@/common/constants/auth';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { getConfig } from '@/config/configuration';
import { hashCacheToken } from '@/shared/caching/cache.constants';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { Prisma, User } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './strategies/jwt-auth.strategy';
import { randomBytes } from 'crypto';

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // client 可传入事务句柄 tx：rotate 把"作废旧的 + 写新的"放进同一事务时需要
  async issue(
    user: User,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const payload: JwtPayload = {
      sub: user.id.toString(),
      type: TokenType.ACCESS,
    };

    const { jwt } = getConfig(this.configService);

    const accessToken = await this.jwtService.signAsync(payload);

    const refreshToken = randomBytes(32).toString('base64url');
    const accessExpiresAt = Date.now() + jwt.accessExpiresIn * 1000;
    const refreshExpiresAt = new Date(Date.now() + jwt.refreshExpiresIn * 1000);

    await client.refreshToken.create({
      data: {
        id: BigInt(generateSnowflakeId()),
        tokenHash: hashCacheToken(refreshToken),
        expiresAt: refreshExpiresAt,
        userId: user.id,
      },
    });
    

    return {
      accessToken,
      refreshToken,
      accessExpiresAt, 
      refreshExpiresAt,
    };
  }
  /**
   * 用 refresh 换新 token：校验 → 作废旧的 → 发新的，**整个放进一个事务**。
   * 为什么要事务（对照 posts update 的 $transaction）：
   *  - 原子性：若发新 token 失败，作废也回滚，用户不会被"凭空登出"。
   *  - 防并发重放：两个请求拿同一个 refresh 并发刷新时，靠"条件作废 + 命中行数"
   *    保证只有一个成功（另一个被行锁挡住后看到已 revoked → 0 行 → 拒绝）。
   */
  async rotate(rawRefresh: string | undefined) {
    if (!rawRefresh) {
      throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
    }
    const hash = hashCacheToken(rawRefresh);
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.refreshToken.findUnique({
        where: { tokenHash: hash },
        include: { user: true },
      });
      if (!record || record.revokedAt || record.expiresAt <= new Date()) {
        throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
      }
      // 条件作废：只在"仍未撤销"时作废。命中 0 行 = 已被并发请求抢先用过 → 拒绝（一次性保证）
      const revoked = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
      return { tokens: await this.issue(record.user, tx) };
    });
  }
  /**
   * 撤销 refresh token（登出 / 主动作废）。
   * 不物理删除：置 revokedAt 即时失效，保留审计轨迹。Redis 命中时同步清除。
   */
  async revoke(refreshToken: string) {
    if (!refreshToken) {
      return;
    }

    await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash: hashCacheToken(refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * 清理已过期的 refresh token。
   * 返回删除的 DB 记录数。Redis key 带 TTL，过期后会自动失效。
   */
  async cleanupExpired(
    now: Date = new Date(),
  ): Promise<{ deletedCount: number }> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    return { deletedCount: result.count };
  }
}
