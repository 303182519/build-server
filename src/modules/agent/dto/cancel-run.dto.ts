import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelRunDto {
  @ApiPropertyOptional({
    description: '取消原因（可选）',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'reason 最多 500 字符' })
  reason?: string;
}
