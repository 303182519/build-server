import { ApiProperty } from '@nestjs/swagger';


export class RoleResponseDto {

  @ApiProperty({ example: 'user' })
  name!: string;

  @ApiProperty({ example: 'user' })
  code!: string;

  @ApiProperty({ example: '普通用户' })
  description?: string;
}


// 对外的用户视图——**永远不含 password**
export class UserResponseDto {
  @ApiProperty({ description: '用户 ID' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ example: 'alice' })
  username!: string;

  @ApiProperty({ type: RoleResponseDto, isArray: true })
  role!: RoleResponseDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'JWT access token，放进 Authorization: Bearer <token>' })
  accessToken!: string;

  @ApiProperty({ format: 'date-time', description: 'access token 过期时间' })
  expiresAt!: string;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;
}
