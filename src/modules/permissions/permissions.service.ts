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

  async update(
    id: bigint,
    updatePermissionDto: UpdatePermissionDto,
  ): Promise<Prisma.PermissionGetPayload<{ select: typeof permissionSelect }>> {
    try {
      // 单次 round-trip：where 显式加 deletedAt: null 保证与 findOne 过滤口径一致，
      // 避免 TOCTOU：预查通过后、update 执行前记录被并发软删
      return await this.prisma.permission.update({
        where: { id, deletedAt: null },
        data: updatePermissionDto,
        select: permissionSelect,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        // 记录不存在 或 已被软删（防御并发 TOCTOU）
        throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
      }
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // 唯一索引冲突：精确区分 name / code（schema 中两者均为 @unique）
        const target = (e.meta?.target as unknown[]) ?? [];
        if (target.includes('name')) {
          throw new ErrorException(
            ErrorExceptionCode.PERMISSION_NAME_ALREADY_EXISTS,
          );
        }
        if (target.includes('code')) {
          throw new ErrorException(
            ErrorExceptionCode.PERMISSION_CODE_ALREADY_EXISTS,
          );
        }
        throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
      }
      throw e;
    }
  }

  async remove(
    id: bigint,
  ): Promise<Prisma.PermissionGetPayload<{ select: typeof permissionSelect }>> {
    try {
      // 与 update 保持一致：deletedAt: null 进 where，杜绝把已软删记录再删一次
      // （软删除幂等性层面虽然危害较小，但语义上"删不存在的东西"应返回 404）
      return await this.prisma.permission.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
        select: permissionSelect,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
      }
      throw e;
    }
  }
}
