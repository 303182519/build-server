import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ============================================================================
// 仅用于 OpenAPI 文档的响应模型（不参与运行时校验，从不被 new）。
// 和领域 Role 模型刻意分开：文档模型描述"线上 JSON 长什么样"。
// BigInt 在 JSON 里被序列化成字符串，Date 被序列化成 ISO 字符串。
// ============================================================================

// 角色关联权限的精简视图：与 RolesService.roleFullSelect 中
// permission 的 select 字段对齐（id/name/code/description，不含时间戳）。
class PermissionSnapshotDto {
  @ApiProperty({ example: '雪花id', description: '权限 ID' })
  id!: string;

  @ApiProperty({ example: '创建用户', description: '权限名称' })
  name!: string;

  @ApiProperty({ example: 'user:create', description: '权限 code' })
  code!: string;

  @ApiPropertyOptional({ example: '允许创建新用户', description: '权限描述' })
  description?: string;
}

export class RoleResponseDto {
  @ApiProperty({ example: '雪花id', description: '角色 ID' })
  id!: string;

  @ApiProperty({ example: 'admin', description: '角色名称' })
  name!: string;

  @ApiPropertyOptional({ example: '管理员', description: '角色描述' })
  description?: string;

  @ApiProperty({ example: 'admin', description: '角色 code（唯一）' })
  code!: string;

  @ApiProperty({
    type: PermissionSnapshotDto,
    isArray: true,
    description: '角色所持有的权限列表',
  })
  permissions!: PermissionSnapshotDto[];

  @ApiProperty({ format: 'date-time', description: '创建时间' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: '更新时间' })
  updatedAt!: string;
}

export class RoleRemoveResponseDto {
  @ApiProperty({ example: true, description: '删除是否成功' })
  success!: boolean;

  @ApiProperty({ example: '雪花id', description: '被删除角色 ID' })
  id!: string;

  @ApiProperty({
    example: 'admin',
    description: '被删除角色 code（审计追溯用）',
  })
  code!: string;
}
