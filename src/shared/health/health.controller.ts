import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Public } from '@/common/decorators/jwt-auth.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { HealthService } from './health.service';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: '健康检查（Docker HEALTHCHECK / 探针 / 负载均衡器）',
  })
  async check(@Res() res: Response) {
    const result = await this.healthService.check();

    // DB 不可用 → 503（Docker 探针判 unhealthy，LB 摘除实例）
    // Cache 不可用 → 200（降级运行，不触发摘除）
    // 全部正常 → 200
    const httpStatus =
      result.status === 'error'
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.OK;

    // 直接发送响应，绕过 ResponseInterceptor 的统一信封包装。
    // 健康检查面向基础设施探针，保持响应体轻量、字段语义清晰。
    res.status(httpStatus).json(result);
  }
}
