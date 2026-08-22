import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ============================================================================
// 仅用于 OpenAPI 文档的响应模型（不参与运行时校验，从不被 new）。
// 和领域 Permission 模型刻意分开：文档模型描述"线上 JSON 长什么样"。
// BigInt 在 JSON 里被序列化成字符串，Date 被序列化成 ISO 字符串。
// ============================================================================

export class PermissionResponseDto {
  @ApiProperty({ example: '雪花id', description: '权限 ID' })
  id!: string;

  @ApiProperty({ example: '创建用户', description: '权限名称' })
  name!: string;

  @ApiProperty({ example: 'user:create', description: '权限 code（唯一）' })
  code!: string;

  @ApiPropertyOptional({ example: '允许创建新用户', description: '权限描述' })
  description?: string;

  @ApiProperty({ format: 'date-time', description: '创建时间' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: '更新时间' })
  updatedAt!: string;
}
