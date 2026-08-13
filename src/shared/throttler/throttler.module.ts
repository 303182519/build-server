import { Module } from '@nestjs/common';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@/config/config.module';
import { getConfig } from '@/config/configuration';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { RedisThrottlerStorage } from './redis-throttler-storage';
import type { RedisClientType } from '@keyv/redis';

@Module({
  imports: [
    NestThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (
        configService: ConfigService,
        redisClient: RedisClientType | null,
      ) => {
        const { throttler } = getConfig(configService);

        const storage = new RedisThrottlerStorage(redisClient);
        return {
          errorMessage: '请求过于频繁，请稍后再试',
          throttlers: [{ ttl: throttler.ttl, limit: throttler.limit }],
          storage,
          // 不向响应中写入 X-RateLimit-* / Retry-After 头
          setHeaders: false,
        };
      },
    }),
  ],
})
export class ThrottlerConfigModule {}
