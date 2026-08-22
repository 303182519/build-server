import { PermissionCodeType } from '@/common/constants/permissions';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

// 出口白名单：返回给前端的字段。新增敏感列（如 internalNote）默认不进 allowlist，
// 杜绝意外泄露。deletedAt 不暴露——前端不应感知软删除实现。
const permissionSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PermissionSelect;

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  create(createPermissionDto: CreatePermissionDto) {
    // id 为雪花 BigInt，schema 未设默认值，需在代码层生成（见 schema.prisma 注释）
    return this.prisma.permission.create({
      data: {
        id: BigInt(generateSnowflakeId()),
        ...createPermissionDto,
      },
      select: permissionSelect,
    });
  }

  findByCodes(codes: PermissionCodeType[]) {
    return this.prisma.permission.findMany({
      where: {
        code: { in: codes },
        deletedAt: null,
      },
    });
  }

  findAll() {
    return this.prisma.permission.findMany({
      where: { deletedAt: null },
      select: permissionSelect,
    });
  }

  // 复刻 TypeORM @DeleteDateColumn 的 find 行为：默认排除软删除记录
  findMany(args: Prisma.PermissionFindManyArgs = {}) {
    return this.prisma.permission.findMany({
      ...args,
      where: { ...args.where, deletedAt: null },
    });
  }

  findOne(id: bigint) {
    return this.prisma.permission.findFirst({
      where: { id, deletedAt: null },
      select: permissionSelect,
    });
  }

  async update(id: bigint, updatePermissionDto: UpdatePermissionDto) {
    const permission = await this.findOne(id);

    if (!permission) {
      throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
    }

    return this.prisma.permission.update({
      where: { id },
      data: updatePermissionDto,
      select: permissionSelect,
    });
  }

  async remove(id: bigint) {
    const permission = await this.findOne(id);

    if (!permission) {
      throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
    }

    // 软删除：置 deletedAt，不物理删除（保留审计轨迹）
    return this.prisma.permission.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: permissionSelect,
    });
  }
}
