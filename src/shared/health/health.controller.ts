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
  @HealthCheck()
  @ApiOperation({
    summary: '健康检查（Docker HEALTHCHECK / 探针 / 负载均衡器）',
  })
  check() {
    return this.health.check([
      // PrismaHealthIndicator 内部执行 SELECT 1，默认 1000ms 超时
      () => this.db.pingCheck('database', this.prisma),
      // Redis 未配置 → degraded（HTTP 200）；不可达 → down（HTTP 503）
      () => this.redis.pingCheck('cache'),
    ]);
  }
}
