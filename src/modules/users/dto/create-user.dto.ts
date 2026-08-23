import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  IsArray,
  IsOptional,
  IsNotEmpty,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    format: 'email',
    maxLength: 255,
    example: 'alice@example.com',
  })
  @IsEmail({}, { message: 'email 格式不正确' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 50,
    description: '只能含字母 / 数字 / 下划线 / 连字符',
    example: 'alice',
  })
  @Length(3, 50, { message: 'username 长度必须在 3 到 50 之间' })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'username 只能含字母/数字/下划线/连字符',
  })
  username!: string;

  @IsNotEmpty({ message: 'password 不能为空' })
  @MinLength(8, { message: 'password 至少 8 位' })
  password!: string;

  @ApiProperty({
    description: '用户角色code列表',
    example: ['admin'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  roles?: string[];
}
