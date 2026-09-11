import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation } from '@nestjs/swagger';
import { Public } from '@/common/decorators/jwt-auth.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { RedisHealthIndicator } from './redis.health';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '存活探针：进程级，不查 DB/Redis',
  })
  liveness() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: '就绪探针：检查 DB 和 Redis，任一不可用返回 503',
  })
  readiness() {
    return this.health.check([
      // PrismaHealthIndicator 内部执行 SELECT 1，默认 1000ms 超时
      () => this.db.pingCheck('database', this.prisma),
      // Redis 未配置 → degraded（HTTP 200）；不可达 → down（HTTP 503）
      () => this.redis.pingCheck('cache'),
    ]);
  }
}
