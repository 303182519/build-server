import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { IsStrongPassword } from '@/common/validators/is-strong-password.validator';
import { CreateUserDto } from '@/modules/users/dto/create-user.dto';

import { OmitType } from '@nestjs/swagger';

export class RegisterDto extends OmitType(CreateUserDto, ['roles']) {
  // 注册期用强度校验替代单纯的 MinLength(8)——含大小写/数字/符号至少 3 种 + 拒常见密码。
  // 注意：登录用的 LoginDto【不】加这个——规则会随时间收紧，不能拿新规则卡住老用户的旧密码。
  @ApiProperty({
    minLength: 8,
    maxLength: 100,
    description: '至少 8 位，含大小写/数字/符号中的至少 3 种，且不能是常见密码',
    example: 'S3cure-pass!',
  })
  @IsString()
  @IsStrongPassword()
  password!: string;
}
