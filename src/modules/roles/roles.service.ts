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

// 带 permissions 关联的完整 select：基础字段 + rolePermissions.permission 嵌套。
// 注意：Prisma 不允许同一查询同时使用 select 与 include（类型层会报
// "Please either choose `select` or `include`"），因此把关联一并放进 select。
// 返回后再将 rolePermissions[].permission 拍平成 permissions[]，与旧 TypeORM 版响应形状对齐。
const roleFullSelect = {
  id: true,
  name: true,
  description: true,
  code: true,
  createdAt: true,
  updatedAt: true,
  rolePermissions: {
    select: {
      permission: {
        select: {
          id: true,
          name: true,
          code: true,
          description: true,
        } satisfies Prisma.PermissionSelect,
      },
    },
  },
} satisfies Prisma.RoleSelect;

type RoleWithPermissionsPayload = Prisma.RoleGetPayload<{
  select: typeof roleFullSelect;
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
    // 入参去重：避免 ['A','A'] 触发重复 in 查询与语义歧义
    const permissionCodes = [...new Set(createRoleDto.permissions ?? [])];

    // 包事务：保证「权限完整性校验 + 角色创建」原子性，
    // 防止校验通过后、写入前权限被软删导致中间态不一致。
    return this.prisma.$transaction(async (tx) => {
      // 权限完整性校验：任一 code 找不到即整体失败，
      // 杜绝 findByCodes 静默丢失导致「用户以为授 3 个权限，实际只落 2 个」。
      let permissions: { id: bigint }[] = [];
      if (permissionCodes.length > 0) {
        permissions = await tx.permission.findMany({
          where: { code: { in: permissionCodes }, deletedAt: null },
          select: { id: true },
        });
        if (permissions.length !== permissionCodes.length) {
          throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
        }
      }

      // code 唯一约束是唯一可靠的防重保障（预检查存在 TOCTOU），
      // TOCTOU 说白了就是"查的时候还在，用的时候没了"。
      // 通过捕获 P2002 转业务错误，避免透传 500 暴露实现细节。
      try {
        const role = await tx.role.create({
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
          select: roleFullSelect,
        });

        return flattenRolePermissions(role);
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          throw new ErrorException(ErrorExceptionCode.ROLE_CODE_EXISTS);
        }
        throw e;
      }
    });
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
      select: roleFullSelect,
    });

    return roles.map(flattenRolePermissions);
  }

  async findOne(id: bigint) {
    const role = await this.prisma.role.findFirst({
      where: { id: id, deletedAt: null },
      select: roleFullSelect,
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
