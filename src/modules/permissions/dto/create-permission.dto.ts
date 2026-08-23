import { PermissionCodeType } from '@/common/constants/permissions';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreatePermissionDto {
  @ApiProperty({
    description: '权限名称',
    example: '创建用户',
  })
  @IsNotEmpty({ message: 'name 不能为空' })
  @IsString({ message: 'name 必须是字符串' })
  name!: string;

  @Matches(/^[a-z]+:[a-z]+$/, {
    message: 'code 格式必须为 xxx:xxx（如 permission:create）',
  })
  code!: PermissionCodeType;

  @IsOptional()
  @IsString({ message: 'description 必须是字符串' })
  description?: string;
}
