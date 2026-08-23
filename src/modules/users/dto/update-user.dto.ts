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
  ValidateIf,
} from 'class-validator';

/**
 * 注意：这里不直接使用 PartialType(OmitType(CreateUserDto, ['password', 'roles']))，
 * 因为需要为可选字段增加 @ValidateIf 条件化校验：
 *   - 当前端回传空字符串 ''（例如清空表单字段）时，跳过 @IsEmail / @Matches 等装饰器校验；
 *   - 只在值为非空字符串（且非 null/undefined）时才执行格式校验。
 *   否则 class-validator 会把 '' 当作有效值进入 @IsEmail，直接抛 Bad Request。
 */
export class UpdateUserDto {
  @ApiProperty({
    format: 'email',
    maxLength: 255,
    example: 'alice@example.com',
    required: false,
  })
  @ValidateIf((o: UpdateUserDto) => o.email !== '' && o.email != null)
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
  @ValidateIf((o: UpdateUserDto) => o.username !== '' && o.username != null)
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
