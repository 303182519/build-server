import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class DecideRunDto {
  @ApiProperty({ description: 'true=批准，false=拒绝', example: true })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    description: '审批意见（拒绝时建议填写）',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'reason 最多 500 字符' })
  reason?: string;
}
