import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from './cache.tokens';
import { withTimeout } from '@/shared/utils/promise';

const PING_TIMEOUT_MS = 1000;

@Injectable()
export class CacheHealthIndicator {
  private readonly logger = new Logger(CacheHealthIndicator.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientType | null,
  ) {}

  async ping(): Promise<boolean> {
    if (!this.redisClient) return true;

    try {
      if (this.redisClient.isOpen === false) {
        await withTimeout(
          this.redisClient.connect(),
          PING_TIMEOUT_MS,
          'Redis CONNECT timeout',
        );
      }

      const result = await withTimeout(
        this.redisClient.ping(),
        PING_TIMEOUT_MS,
        'Redis PING timeout',
      );

      return result === 'PONG';
    } catch (err) {
      this.logger.warn(
        `Redis PING 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
