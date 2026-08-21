import { TokenType } from '@/common/constants/auth';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { getConfig } from '@/config/configuration';
import { UsersService } from '@/modules/users/users.service';
import { CacheKeys, hashCacheToken } from '@/shared/caching/cache.constants';
import { CacheService } from '@/shared/caching/cache.service';
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
    private readonly cacheService: CacheService,
    private readonly usersService: UsersService,
  ) {}

  async create(user: User) {
    const tokens = this.generateTokens(user);

    if (this.cacheService.isRedisEnabled()) {
      const { jwt } = getConfig(this.configService);
      await this.cacheService.set(
        CacheKeys.AUTH_REFRESH_TOKEN(tokens.refreshToken),
        user.id.toString(),
        jwt.refreshExpiresIn,
      );
    }

    await this.prisma.refreshToken.create({
      data: {
        id: BigInt(generateSnowflakeId()),
        tokenHash: hashCacheToken(tokens.refreshToken),
        expiresAt: tokens.refreshExpiresAt,
        userId: user.id,
      },
    });

    return tokens;
  }

  async refreshToken(refreshToken: string | undefined) {
    if (!refreshToken) {
      throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
    }

    if (this.cacheService.isRedisEnabled()) {
      return this.refreshTokenViaRedis(refreshToken);
    }
    return this.refreshTokenViaDb(refreshToken);
  }

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

  generateTokens(user: User) {
    const payload: JwtPayload = {
      sub: user.id.toString(),
      type: TokenType.ACCESS,
    };

    const { jwt } = getConfig(this.configService);

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { ...payload, type: TokenType.REFRESH },
      {
        expiresIn: jwt.refreshExpiresIn,
      },
    );

    const accessExpiresAt = Date.now() + jwt.accessExpiresIn * 1000;
    const refreshExpiresAt = new Date(Date.now() + jwt.refreshExpiresIn * 1000);

    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  /**
   * 撤销 refresh token（登出 / 主动作废）。
   * 不物理删除：置 revokedAt 即时失效，保留审计轨迹。Redis 命中时同步清除。
   */
  async revoke(refreshToken: string) {
    if (!refreshToken) {
      return;
    }

    if (this.cacheService.isRedisEnabled()) {
      await this.cacheService.del(CacheKeys.AUTH_REFRESH_TOKEN(refreshToken));
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

  private async refreshTokenViaDb(refreshToken: string) {
    const tokenRecord = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashCacheToken(refreshToken) },
      include: { user: true },
    });

    if (
      !tokenRecord ||
      tokenRecord.revokedAt ||
      tokenRecord.expiresAt < new Date()
    ) {
      throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
    }

    const tokens = this.generateTokens(tokenRecord.user);
    const now = new Date();

    // 轮换：撤销旧 token，写入新 token（旧 token 立即作废）
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: { revokedAt: now },
      }),
      this.prisma.refreshToken.create({
        data: {
          id: BigInt(generateSnowflakeId()),
          tokenHash: hashCacheToken(tokens.refreshToken),
          expiresAt: tokens.refreshExpiresAt,
          userId: tokenRecord.userId,
        },
      }),
    ]);

    if (this.cacheService.isRedisEnabled()) {
      const { jwt } = getConfig(this.configService);
      await this.cacheService.set(
        CacheKeys.AUTH_REFRESH_TOKEN(tokens.refreshToken),
        tokenRecord.userId.toString(),
        jwt.refreshExpiresIn,
      );
    }

    return tokens;
  }

  private async refreshTokenViaRedis(refreshToken: string) {
    const oldKey = CacheKeys.AUTH_REFRESH_TOKEN(refreshToken);
    const userId = await this.cacheService.get<string>(oldKey);

    if (!userId) {
      return this.refreshTokenViaDb(refreshToken);
    }

    let user: User;
    try {
      user = await this.usersService.findOne({ id: userId });
    } catch {
      // 用户已被删除等情况：清理孤立的 refresh token 并拒绝
      await this.cacheService.del(oldKey);
      throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
    }

    const tokens = this.generateTokens(user);
    const { jwt } = getConfig(this.configService);

    const rotated = await this.cacheService.rotateRefreshToken(
      oldKey,
      CacheKeys.AUTH_REFRESH_TOKEN(tokens.refreshToken),
      userId,
      jwt.refreshExpiresIn,
    );

    if (!rotated) {
      throw new ErrorException(ErrorExceptionCode.INVALID_REFRESH_TOKEN);
    }

    // 轮换：撤销旧 DB 记录，写入新记录
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: {
          tokenHash: hashCacheToken(refreshToken),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
      this.prisma.refreshToken.create({
        data: {
          id: BigInt(generateSnowflakeId()),
          tokenHash: hashCacheToken(tokens.refreshToken),
          expiresAt: tokens.refreshExpiresAt,
          userId: user.id,
        },
      }),
    ]);

    return tokens;
  }
}
