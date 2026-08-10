import { AppConfigModule } from '@/config/config.module';
import { getConfig } from '@/config/configuration';
import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { Keyv } from 'keyv';
import KeyvRedis from '@keyv/redis';
import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CacheHealthIndicator } from './cache.health';
import { REDIS_CLIENT } from './cache.tokens';
import { CacheService } from './cache.service';
import { HashCacheService } from './hash-cache.service';

const buildRedisUrl = (redis: {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}): string | undefined => {
  if (redis.url) return redis.url;
  if (!redis.host) return undefined;
  const auth = redis.password ? `:${encodeURIComponent(redis.password)}@` : '';
  const db = typeof redis.db === 'number' ? `/${redis.db}` : '';
  return `redis://${auth}${redis.host}:${redis.port ?? 6379}${db}`;
};

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { redis } = getConfig(configService);
        const url = buildRedisUrl(redis);
        // 默认缓存过期时间：毫秒，60秒
        const ttl = redis.defaultTtl * 1000;

        if (!url) {
          // 未配置 Redis，使用 Keyv 默认内存 store
          return {
            stores: [new Keyv({ namespace: redis.keyPrefix })],
            ttl,
          };
        }

        const keyvRedis = new KeyvRedis(url, {
          namespace: redis.keyPrefix,
          // 默认 true 会在连接失败时抛错；本期降级策略由 OnApplicationBootstrap 处理
          throwOnConnectError: false,
        });

        return {
          stores: [new Keyv({ store: keyvRedis, namespace: redis.keyPrefix })],
          ttl,
        };
      },
    }),
  ],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [CACHE_MANAGER],
      useFactory: (cache: Cache) => {
        for (const keyv of cache.stores) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const store = keyv.store;
          if (store instanceof KeyvRedis) return store.client;
        }

        return null;
      },
    },
    CacheService,
    HashCacheService,
    CacheHealthIndicator,
  ],
  exports: [CacheService, HashCacheService, REDIS_CLIENT],
})
export class RedisCacheModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(RedisCacheModule.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly health: CacheHealthIndicator,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { redis } = getConfig(this.configService);
    const url = buildRedisUrl(redis);

    if (!url) {
      this.logger.warn('Redis 未配置，缓存模块使用内存 store');
      return;
    }

    const healthy = await this.health.ping();
    if (healthy) {
      this.logger.log(`Redis 连接正常 (prefix=${redis.keyPrefix})`);
      return;
    }

    this.logger.error('Redis 已配置但不可达，启动终止');
    throw new Error('Redis is configured but not reachable');
  }
}
