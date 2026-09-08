import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { RedisClientType } from '@keyv/redis';
import { REDIS_CLIENT } from '@/shared/caching/cache.tokens';
import { withTimeout } from '@/shared/utils/promise';

const PING_TIMEOUT_MS = 2000;

/**
 * Redis 缓存健康指标（Terminus 自定义 Indicator）。
 *
 * 状态语义：
 * - up：Redis 已配置且 PING 成功
 * - degraded：Redis 未配置（系统降级为内存 store，业务可用）
 * - down：Redis 已配置但不可达
 */
@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(
    private readonly indicator: HealthIndicatorService,
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientType | null,
  ) {}

  async pingCheck(key: string) {
    // Redis 未配置 → degraded（不触发 503，系统降级运行）
    if (!this.redisClient) {
      return this.indicator.check(key).degraded({ message: 'not configured' });
    }

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

      if (result === 'PONG') {
        return this.indicator.check(key).up();
      }
      return this.indicator
        .check(key)
        .down({ message: `unexpected: ${result}` });
    } catch (err) {
      this.logger.warn(
        `Redis health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.indicator.check(key).down({
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
