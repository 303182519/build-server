import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PermissionsService } from '../permissions/permissions.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

// 出口白名单：不暴露 deletedAt（软删除是实现细节）。
// permissions 通过 rolePermissions 中间表二次拉取后拍平，
// 这里先声明不带 relation 的 role 基础字段。
const roleBaseSelect = {
  id: true,
  name: true,
  description: true,
  code: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RoleSelect;

// 带 permissions 关联的 include：通过显式 join 表 rolePermissions 拉取 permission。
// 返回后再将 rolePermissions[].permission 拍平成 permissions[]，与旧 TypeORM 版响应形状对齐。
const roleWithPermissionsInclude = {
  rolePermissions: {
    include: {
      permission: {
        select: {
          id: true,
          name: true,
          code: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        } satisfies Prisma.PermissionSelect,
      },
    },
  },
} satisfies Prisma.RoleInclude;

type RoleWithPermissionsPayload = Prisma.RoleGetPayload<{
  select: typeof roleBaseSelect;
  include: typeof roleWithPermissionsInclude;
}>;

/**
 * 将 Prisma 返回的 { rolePermissions: [{ permission }] } 拍平为 { permissions }[]，
 * 保持与旧 TypeORM 实体直接挂 permissions 的响应形状一致，避免下游（controller /
 * 前端响应 / 其他 service 调用方）破坏性改动。
 */
function flattenRolePermissions<T extends RoleWithPermissionsPayload>(
  role: T,
): Omit<T, 'rolePermissions'> & {
  permissions: T['rolePermissions'][number]['permission'][];
} {
  const { rolePermissions, ...rest } = role;
  return {
    ...rest,
    permissions: rolePermissions.map((rp) => rp.permission),
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async create(createRoleDto: CreateRoleDto) {
    const permissions = await this.permissionsService.findByCodes(
      createRoleDto.permissions,
    );

    const role = await this.prisma.role.create({
      data: {
        id: BigInt(generateSnowflakeId()),
        name: createRoleDto.name,
        description: createRoleDto.description,
        code: createRoleDto.code,
        rolePermissions: {
          create: permissions.map((permission) => ({
            permissionId: permission.id,
          })),
        },
      },
      select: roleBaseSelect,
      include: roleWithPermissionsInclude,
    });

    return flattenRolePermissions(role);
  }

  findByCodes(codes: string[]) {
    // 注意：此处仅返回 role 基础字段（不带 permissions），与旧 TypeORM 版行为一致；
    // 主要消费者是 UsersService.create / updateUserRoles，仅需要 role id/code 做关联。
    return this.prisma.role.findMany({
      where: {
        code: { in: codes },
        deletedAt: null,
      },
      select: roleBaseSelect,
    });
  }

  findByUser(userId: string) {
    // userId 来自 controller / useRequestUser，为字符串形式的雪花 ID；
    // Prisma UserRoles.userId 为 BigInt，需在此转换。
    return this.prisma.role.findMany({
      where: {
        users: {
          some: {
            userId: BigInt(userId),
          },
        },
        deletedAt: null,
      },
      select: roleBaseSelect,
    });
  }

  async findAll() {
    const roles = await this.prisma.role.findMany({
      where: { deletedAt: null },
      select: roleBaseSelect,
      include: roleWithPermissionsInclude,
    });

    return roles.map(flattenRolePermissions);
  }

  async findOne(id: bigint) {
    const role = await this.prisma.role.findFirst({
      where: { id: id, deletedAt: null },
      select: roleBaseSelect,
      include: roleWithPermissionsInclude,
    });

    return role ? flattenRolePermissions(role) : null;
  }

  async update(id: bigint, updateRoleDto: UpdateRoleDto) {
    const existing = await this.prisma.role.findFirst({
      where: { id: id, deletedAt: null },
      select: { id: true },
    });

    if (!existing) {
      throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
    }

    // 解构：permissions 不走 spread，走 rolePermissions 关联更新
    const { permissions: permissionCodes, ...roleData } = updateRoleDto;

    // 构造 data：先放基础字段（可能为 undefined 时不写 key）
    const data: Prisma.RoleUpdateInput = { ...roleData };

    if (permissionCodes && permissionCodes.length > 0) {
      const permissions =
        await this.permissionsService.findByCodes(permissionCodes);
      data.rolePermissions = {
        // set 先清再插：语义等价于"用这组权限完全替换旧权限"，
        // 与旧 TypeORM merge(role, { permissions }) 的覆盖行为一致。
        set: permissions.map((permission) => ({
          roleId_permissionId: {
            roleId: id,
            permissionId: permission.id,
          },
        })),
      };
    }

    await this.prisma.role.update({
      where: { id: id },
      data,
      select: { id: true },
    });

    return { success: true };
  }

  async remove(id: bigint) {
    const existing = await this.prisma.role.findFirst({
      where: { id: id, deletedAt: null },
      select: { id: true },
    });

    if (!existing) {
      throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
    }

    // 软删除：置 deletedAt，不物理删除（保留审计轨迹）
    await this.prisma.role.update({
      where: { id: id },
      data: { deletedAt: new Date() },
      select: { id: true },
    });

    return { success: true };
  }
}
