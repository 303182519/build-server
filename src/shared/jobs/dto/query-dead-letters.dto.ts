import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 死信查询参数。
 *
 * timeoutMinutes 定义「非终态任务停留多久视为死信」的阈值，
 * 默认 30 分钟。对于执行时间较长的任务类型，应调大此值以避免误判。
 */
export class QueryDeadLettersDto {
  @ApiPropertyOptional({
    description: '死信阈值（分钟），非终态任务超过此时间视为死信',
    example: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  timeoutMinutes?: number = 30;

  @ApiPropertyOptional({
    description: '按任务名过滤',
    example: 'export-report',
  })
  @IsOptional()
  @IsString()
  name?: string;
}
