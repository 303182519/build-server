import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsString, MinLength, IsNotEmpty } from 'class-validator';
import { IsStrongPassword } from '@/common/validators/is-strong-password.validator';

export class UpdatePasswordDto {
  @ApiProperty({
    description: 'The old password',
    example: 'password',
  })
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: 100,
    description: '至少 8 位，含大小写/数字/符号中的至少 3 种，且不能是常见密码',
    example: 'S3cure-pass!',
  })
  @IsString()
  @IsStrongPassword()
  newPassword!: string;
}

export class UpdatePasswordByAdminDto extends PickType(UpdatePasswordDto, [
  'newPassword',
] as const) {}
