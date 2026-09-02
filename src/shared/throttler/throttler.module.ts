import { Module } from '@nestjs/common';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@/config/config.module';
import { getConfig } from '@/config/configuration';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { RedisThrottlerStorage } from './redis-throttler-storage';
import type { RedisClientType } from '@keyv/redis';
import type { ExecutionContext } from '@nestjs/common';

/**
 * 生成可读的限流 key。
 *
 * 默认 @nestjs/throttler 的 generateKey 会对 `Class-Handler-name-tracker` 做 SHA256，
 * 落盘 key 全是 hash，redis-cli 不可读。这里 override 为可读格式，
 * 同时保留 Class + Handler 维度的隔离（login 和 register 各自 10/min 互不影响）。
 *
 * 最终落盘：throttle:{counter|block}:{name}:{Class}-{Handler}-{name}-{tracker}
 * 示例：throttle:block:default:AuthController-login-default-user:abc123
 */
const readableGenerateKey = (
  context: ExecutionContext,
  tracker: string,
  name: string,
): string => {
  const className = context.getClass().name;
  const handlerName = context.getHandler().name;
  return `${className}-${handlerName}-${name}-${tracker}`;
};

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
          generateKey: readableGenerateKey,
          // 不向响应中写入 X-RateLimit-* / Retry-After 头
          setHeaders: false,
        };
      },
    }),
  ],
})
export class ThrottlerConfigModule {}
