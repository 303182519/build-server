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
    });
  }
}
