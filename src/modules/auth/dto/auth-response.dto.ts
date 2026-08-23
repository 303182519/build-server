import { ApiProperty } from '@nestjs/swagger';

class RoleResponseDto {
  @ApiProperty({ example: 'user' })
  name!: string;

  @ApiProperty({ example: 'user' })
  code!: string;
}

// 对外的用户视图——**永远不含 password**
class UserResponseDto {
  @ApiProperty({ description: '用户 ID' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ example: 'alice' })
  username!: string;

  // ✅ 用户角色列表
  @ApiProperty({
    type: RoleResponseDto,
    isArray: true,
    description: '用户角色列表',
  })
  roles!: RoleResponseDto[];

  // ✅ 用户权限 code 数组，前端做按钮/菜单权限判断，只返回 code 字符串数组最实用
  @ApiProperty({
    type: String,
    isArray: true,
    description:
      '用户权限 code 数组，前端做按钮/菜单权限判断，只返回 code 字符串数组最实用',
  })
  permissions!: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AuthResponseDto {
  @ApiProperty({
    description: 'JWT access token，放进 Authorization: Bearer <token>',
  })
  accessToken!: string;

  @ApiProperty({
    example: 1787304408044,
    description: 'access token 过期时间, 单位：毫秒',
  })
  expiresAt!: number;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;
}

export class RefreshResponseDto {
  @ApiProperty({
    description: 'JWT access token，放进 Authorization: Bearer <token>',
  })
  accessToken!: string;

  @ApiProperty({
    example: 1787304408044,
    description: 'access token 过期时间, 单位：毫秒',
  })
  expiresAt!: number;
}
