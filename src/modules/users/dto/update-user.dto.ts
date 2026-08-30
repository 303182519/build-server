import { RoleCode } from '@/common/constants/roles';
import { SpecialRolesEnum } from '@/common/decorators/special-roles.decorator';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * 注意：这里不直接使用 PartialType(OmitType(CreateUserDto, ['password', 'roles']))，
 * 因为可选字段的契约是「未修改就不传」：
 *   - 传 ''：@IsEmail / @Matches 直接拒绝（400，fail-fast），不静默吞掉，避免掩盖前端 bug；
 *   - 传 null：@IsOptional 放行，由 service 层归一化为「未提交」兜底，
 *     避免 {"email": null} 静默清空登录凭证。
 */
export class UpdateUserDto {
  @ApiProperty({
    format: 'email',
    maxLength: 255,
    example: 'alice@example.com',
    required: false,
  })
  @IsEmail({}, { message: 'email 格式不正确' })
  @MaxLength(255)
  @IsOptional()
  email?: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 50,
    description: '只能含字母 / 数字 / 下划线 / 连字符',
    example: 'alice',
    required: false,
  })
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'username 只能含字母/数字/下划线/连字符',
  })
  @IsOptional()
  username?: string;
}

export class UpdateUserRolesDto {
  @ApiProperty({
    description: '用户角色code列表',
    example: [RoleCode.ADMIN],
  })
  @IsArray()
  @IsString({ each: true })
  roles: string[];
}

export class UpdateUserSpecialRolesDto {
  @ApiProperty({
    description: '用户特殊角色code列表',
    example: [SpecialRolesEnum.Developer],
  })
  @IsEnum(SpecialRolesEnum, { each: true })
  roles: SpecialRolesEnum[];
}
