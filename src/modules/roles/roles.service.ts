import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleCode } from '@/common/constants/roles';

import { useRequestUser } from '@/common/context/user-context';

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
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    // 包事务：保证「存在性 + 系统角色保护 + 权限完整性校验 + 更新」原子性，
    // 与 create / remove 的 $transaction 惯例一致，防止校验通过后、写入前状态漂移。
    return this.prisma.$transaction(async (tx) => {
      // 1. 存在性 + 取 code（用于系统角色判定）
      const existing = await tx.role.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, code: true },
      });

      if (!existing) {
        throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
      }

      // 2. 系统内置角色保护
      if (existing.code === RoleCode.ADMIN) {
        throw new ErrorException(ErrorExceptionCode.ROLE_IS_SYSTEM);
      }

      // 解构：permissions 不走 spread，走 rolePermissions 关联更新
      const { permissions: permissionCodes, ...roleData } = updateRoleDto;

      // 构造 data：先放基础字段（可能为 undefined 时不写 key）
      const data: Prisma.RoleUpdateInput = { ...roleData };

      // 3. 权限处理：区分 undefined（不更新）/ []（清空）/ [...]（替换）。
      //    旧代码 `length > 0` 会漏掉显式清空场景，语义错误。
      if (permissionCodes !== undefined) {
        // 权限完整性校验：任一 code 找不到即整体失败，
        // 与 create 的校验对齐，杜绝「以为授 3 个，实际只落 2 个」。
        // 否则脱离事务读不到事务内最新状态（create 也是直接用 tx.permission）。
        const permissions =
          permissionCodes.length > 0
            ? await tx.permission.findMany({
                where: { code: { in: permissionCodes }, deletedAt: null },
                select: { id: true },
              })
            : [];

        if (permissions.length !== permissionCodes.length) {
          throw new ErrorException(ErrorExceptionCode.PERMISSION_NOT_FOUND);
        }

        // set 先清再插：语义等价于"用这组权限完全替换旧权限"，
        // set: [] 即清空所有权限。
        /* 底层其实是这个流程：
          1. SELECT 现有的 rolePermissions WHERE roleId = ?
          2. client 端做 diff：
            - 旧有 + 新无 → 待删
            - 旧有 + 新有 → 保留（不动）
            - 旧无 + 新有 → 待插
          3. DELETE 待删的行（多条或一条 WHERE id IN ...）
          4. INSERT 待插的行 
        */
        data.rolePermissions = {
          set: permissions.map((permission) => ({
            //  @@id([roleId, permissionId])   // 复合主键
            roleId_permissionId: {
              roleId: id,
              permissionId: permission.id,
            },
          })),
        };
      }

      // 4. 更新 + 捕获 P2025：findFirst 通过后、update 前被并发删除（TOCTOU），
      //    与 remove 捕获 P2025 的惯例对齐，避免透传 500 暴露实现细节。
      let updated: Prisma.RoleGetPayload<{ select: typeof roleFullSelect }>;
      try {
        updated = await tx.role.update({
          where: { id },
          data,
          select: roleFullSelect,
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
        }
        throw e;
      }

      // 5. 操作人审计：与 remove 惯例对齐，记录修改轨迹。
      try {
        const operator = useRequestUser();
        this.logger.log(
          `Role updated: id=${id}, code=${existing.code}, operator=${operator.id}`,
        );
      } catch {
        this.logger.log(`Role updated: id=${id}, code=${existing.code}`);
      }

      // 6. 返回更新后的完整角色（含 permissions）：与 create 的返回形状对齐，
      //    前端无需再发一次 GET 请求；RESTful PATCH 惯例也要求返回更新后资源。
      return flattenRolePermissions(updated);
    });
  }

  async remove(id: bigint) {
    // 包事务：保证「存在性 + 系统角色保护 + 引用完整性 + 软删」原子性，
    // 与 create 的 $transaction 惯例一致，防止校验通过后、写入前状态漂移。
    return this.prisma.$transaction(async (tx) => {
      // 1. 存在性 + 取 code（用于系统角色判定与返回值追溯）
      const role = await tx.role.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, code: true },
      });

      if (!role) {
        throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
      }

      // 2. 系统内置角色保护
      if (role.code === RoleCode.ADMIN) {
        throw new ErrorException(ErrorExceptionCode.ROLE_IS_SYSTEM);
      }

      // 3. 引用完整性：角色仍被用户持有时禁止软删。
      //    软删后 findByUser 通过 role.deletedAt 过滤会让用户静默丢权限，
      //    属「未授权的权限收回」，企业级必须显式拒绝并要求先解绑。
      const userCount = await tx.userRoles.count({
        where: { roleId: id },
      });

      if (userCount > 0) {
        throw new ErrorException(ErrorExceptionCode.ROLE_IN_USE);
      }

      // 4. 级联清理 RolePermissions：物理删，恢复时由管理员显式重配。
      //    理由：避免恢复后历史权限"幽灵复活"——权限模型可能已重构，
      //    旧权限复活会形成未被授权的能力授予。
      //    审计走 Logger 文本（步骤 7），不依赖 RolePermissions.id 作外键，
      //    物理删无损审计轨迹；deleteMany 对 0 行也成功，无需 try/catch。
      //
      //    UserRoles 不在此处理：步骤 3 的 userCount 拦截已保证到达此处时
      //    无活跃用户绑定（userCount > 0 即抛 ROLE_IN_USE），无需级联。
      await tx.rolePermissions.deleteMany({ where: { roleId: id } });

      // 5. 软删 Role：置 deletedAt 保留审计轨迹与可恢复性。
      //    不同于步骤 4 物理删 RolePermissions，Role 主表软删——
      //    主数据是治理对象，需支持误删恢复与历史审计追溯。
      try {
        await tx.role.update({
          where: { id },
          data: { deletedAt: new Date() },
          select: { id: true },
        });
      } catch (e) {
        // 6. P2025：findFirst 通过后、update 前被并发删除（TOCTOU）。
        //    与 create 捕获 P2002 转业务错误的惯例对齐，避免透传 500 暴露实现细节。
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
        }
        throw e;
      }

      // 7. 操作人审计：项目无 AuditLog 服务，用 Logger 记录最小轨迹。
      //    useRequestUser() 仅在请求生命周期内可用；非请求上下文（如定时任务）
      //    降级仍记角色信息，保证至少有「发生了删除」的可追溯线索。
      //    日志内容覆盖"软删 Role + 物理删 RolePermissions"两件事，
      //    作为步骤 4 物理删的间接审计证据（无外键依赖的替代追溯线索）。
      try {
        const operator = useRequestUser();
        this.logger.log(
          `Role removed (soft) + RolePermissions purged: id=${id}, code=${role.code}, operator=${operator.id}`,
        );
      } catch {
        this.logger.log(
          `Role removed (soft) + RolePermissions purged: id=${id}, code=${role.code}`,
        );
      }

      // 返回 id/code/permissionsReset：
      //   - id/code：前端/下游日志可关联到被删角色，{success} 单字段信息不足。
      //   - permissionsReset：显式契约——告知"权限已物理清空"，
      //     恢复时需重配权限，避免下游误以为"原权限还在"导致恢复后出现权限缺口。
      return { success: true, id, code: role.code, permissionsReset: true };
    });
  }
}
