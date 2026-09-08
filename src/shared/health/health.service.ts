import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { CacheHealthIndicator } from '@/shared/caching/cache.health';

/** 单次健康探针最大等待时间（毫秒） */
const PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  /** 进程启动时间戳，用于计算 uptime */
  private readonly startTime = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheHealth: CacheHealthIndicator,
  ) {}

  async check(): Promise<{
    status: 'ok' | 'degraded' | 'error';
    uptime: number;
    checks: {
      database: 'up' | 'down';
      cache: 'up' | 'down' | 'not_configured';
    };
  }> {
    const checks: {
      database: 'up' | 'down';
      cache: 'up' | 'down' | 'not_configured';
    } = {
      database: 'down',
      cache: 'not_configured',
    };

    // ── Database 探针 ──
    // Prisma.$queryRaw 继承 PrismaClient 的连接池；连接断开时会在 PROBE_TIMEOUT_MS 内 reject
    try {
      await Promise.race([
        this.prisma.$queryRawUnsafe<{ 1: bigint }[]>('SELECT 1'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Database probe timeout')),
            PROBE_TIMEOUT_MS,
          ),
        ),
      ]);
      checks.database = 'up';
    } catch (err) {
      this.logger.warn(
        `Database health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Cache 探针 ──
    // CacheHealthIndicator.ping() 内部处理了 Redis 未配置（返回 true）和连接异常（返回 false）
    try {
      const cacheOk = await this.cacheHealth.ping();
      checks.cache = cacheOk ? 'up' : 'down';
    } catch (err) {
      this.logger.warn(
        `Cache health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      checks.cache = 'down';
    }

    // ── 聚合状态 ──
    // DB 不可用 → error（核心依赖，服务无法正常工作）
    // Cache 不可用 → degraded（降级运行，缓存失效但业务可用）
    let status: 'ok' | 'degraded' | 'error';
    if (checks.database === 'down') {
      status = 'error';
    } else if (checks.cache === 'down') {
      status = 'degraded';
    } else {
      status = 'ok';
    }

    return {
      status,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks,
    };
  }
}
