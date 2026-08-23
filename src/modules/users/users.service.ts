import { isRequestUser, useRequestUser } from '@/common/context/user-context';
import { SpecialRolesEnum } from '@/common/decorators/special-roles.decorator';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Permission, Prisma } from '@prisma/client';
import { hash, verify } from 'argon2';
import { PermissionsService } from '../permissions/permissions.service';
import { RolesService } from '../roles/roles.service';
import { CreateUserDto } from './dto/create-user.dto';
import { FindUsersDto } from './dto/find-users.dto';
import {
  UpdatePasswordByAdminDto,
  UpdatePasswordDto,
} from './dto/update-password.dto';
import {
  UpdateUserDto,
  UpdateUserRolesDto,
  UpdateUserSpecialRolesDto,
} from './dto/update-user.dto';

// ---------- Prisma select 白名单 ----------
// 出口脱敏：password / deletedAt 一律不进 select（deletedAt 是软删除实现细节）。

const userBaseSelect = {
  id: true,
  email: true,
  username: true,
  specialRoles: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type UserBasePayload = Prisma.UserGetPayload<{
  select: typeof userBaseSelect;
}>;

// 带 roles 的完整 select：注意 Prisma 多对多走中间表，返回形状是
// { roles: [{ role: { code, name, ... } }] }，需拍平为 { roles: Role[] }
// 与旧 TypeORM 版响应对齐（controller / 前端消费方不感知中间表）。
const userWithRolesSelect = {
  id: true,
  email: true,
  username: true,
  specialRoles: true,
  createdAt: true,
  updatedAt: true,
  roles: {
    select: {
      role: {
        select: {
          id: true,
          name: true,
          description: true,
          code: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
        } satisfies Prisma.RoleSelect,
      },
    },
  },
} satisfies Prisma.UserSelect;

type UserWithRolesPayload = Prisma.UserGetPayload<{
  select: typeof userWithRolesSelect;
}>;

type RoleFlatPayload =
  UserWithRolesPayload['roles'][number]['role'];

type UserWithFlatRoles = UserBasePayload & {
  roles: RoleFlatPayload[];
};

/**
 * 将 Prisma 返回的 { roles: [{ role }] } 拍平为 { roles: Role[] }，
 * 保持与旧 TypeORM 直接挂 roles 的响应形状一致，避免下游破坏性改动。
 */
function flattenUserRoles(user: UserWithRolesPayload): UserWithFlatRoles {
  const { roles, ...rest } = user;
  return {
    ...rest,
    roles: roles.map((ur) => ur.role),
  };
}

/**
 * 将字符串 ID（来自路由参数 / DTO / JWT sub）转换为 Prisma 需要的 BigInt。
 * 非法字符串（空 / NaN）直接抛 USER_NOT_FOUND，与"查不到"等价——省一次数据库往返。
 */
function toBigIntId(id: string): bigint {
  if (!id) {
    throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
  }
  try {
    return BigInt(id);
  } catch {
    throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
  }
}

/**
 * DTO specialRoles 是枚举数组（为未来多值扩展预留），
 * 但当前 Prisma schema 中 specialRoles 是 VARCHAR(255) 单值，
 * 且 guard / remove 逻辑都按单值判断（=== 比较、matchRoles 包 [v] 单元素数组）。
 * 因此这里取数组第一个元素（undefined / 空数组 → null）。
 */
function specialRolesFromDto(
  roles: SpecialRolesEnum[] | undefined,
): string | null {
  if (!roles || roles.length === 0) return null;
  return roles[0];
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rolesService: RolesService,
    private readonly permissionsService: PermissionsService,
    private readonly configService: ConfigService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<UserBasePayload> {
    // 预查存在性：username / email 任一重复即失败。
    // 虽然 Prisma 唯一约束 + 捕获 P2002 也能兜底，但预查能更早给出更准确的语义错误。
    const exist = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { username: createUserDto.username },
          { email: createUserDto.email },
        ],
      },
      select: { id: true },
    });
    if (exist) {
      throw new ErrorException(ErrorExceptionCode.USER_ALREADY_EXISTS);
    }

    const hashedPassword = await hash(createUserDto.password, {
      timeCost: 5,
    });

    // 角色完整性校验：与 RolesService.create 的策略对齐——任一 code 找不到即整体失败，
    // 杜绝「以为授 3 个角色，实际只落 2 个」的静默丢失。
    const roleCodes = createUserDto.roles ?? [];
    let roleIds: { id: bigint }[] = [];
    if (roleCodes.length > 0) {
      const roles = await this.rolesService.findByCodes(roleCodes);
      if (roles.length !== roleCodes.length) {
        throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
      }
      roleIds = roles.map((r) => ({ id: r.id }));
    }

    try {
      const user = await this.prisma.user.create({
        data: {
          id: BigInt(generateSnowflakeId()),
          email: createUserDto.email,
          username: createUserDto.username,
          password: hashedPassword,
          roles:
            roleIds.length > 0
              ? {
                  create: roleIds.map((r) => ({
                    roleId: r.id,
                  })),
                }
              : undefined,
        },
        select: userBaseSelect,
      });
      return user;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // TOCTOU：并发下预查通过、写入时撞唯一约束
        throw new ErrorException(ErrorExceptionCode.USER_ALREADY_EXISTS);
      }
      throw e;
    }
  }

  async getProfile(): Promise<UserWithFlatRoles> {

    const id = useRequestUser().id;

    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: userWithRolesSelect,
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    return flattenUserRoles(user);
  }

  async getPermissions(): Promise<Permission[]> {
    const id = useRequestUser().id;

    // 单次嵌套 filter：Permission → rolePermissions → role → users 反向过滤到当前用户，
    // 替代旧 TypeORM 版 `where: { roles: { id: In(...) } }` 与本服务旧版「先查 roles 再查 permissions」两段式，
    // 消除一次 DB 往返与 roleIds 中间数组物化。
    // role.deletedAt: null 对齐 rolesService.findByUser 的软删过滤语义。
    return this.permissionsService.findMany({
      where: {
        rolePermissions: {
          some: {
            role: {
              users: { some: { userId: id } },
              deletedAt: null,
            },
          },
        },
      },
    });
  }

  async findAll(
    { page = 1, pageSize = 20, search }: FindUsersDto = {},
  ): Promise<{
    list: UserWithFlatRoles[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    // 强制分页：避免全表返回造成内存与响应膨胀，pageSize 由 DTO 限制最大 100。
    // 注意：Prisma schema 无 displayName 字段，这里只按 username / email 模糊搜索。
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
    };
    if (search) {
      where.OR = [
        { username: { contains: search } },
        { email: { contains: search } },
      ];
    }

    const [list, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: userWithRolesSelect,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      list: list.map(flattenUserRoles),
      total,
      page,
      pageSize,
    };
  }

  async findOne(
    criteria: { id?: bigint; username?: string; email?: string },
    relations?: Prisma.UserInclude,
  ): Promise<any> {
    const includeRoles =
      typeof relations === 'object' &&
      relations !== null &&
      'roles' in relations &&
      (relations as { roles?: boolean }).roles === true;


    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (criteria.id) where.id = criteria.id;
    if (criteria.username) where.username = criteria.username;
    if (criteria.email) where.email = criteria.email;

    if (includeRoles) {
      const user = await this.prisma.user.findFirst({
        where,
        select: userWithRolesSelect,
      });
      if (!user) {
        throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
      }
      return flattenUserRoles(user);
    }

    const user = await this.prisma.user.findFirst({
      where,
      select: userBaseSelect,
    });
    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }
    return user;
  }

  updateProfile(updateProfileDto: UpdateUserDto) {
    const userId = useRequestUser().id as bigint;
    return this.update(userId.toString(), updateProfileDto);
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<UserBasePayload> {
    const prismaId = toBigIntId(id);

    const user = await this.prisma.user.findFirst({
      where: { id: prismaId, deletedAt: null },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    // 默认管理员的用户名不可更改：用浅拷贝避免 mutate 入参 DTO
    const defaultAdminUsername = this.configService.get<string>(
      'DEFAULT_ADMIN_USERNAME',
    );

    const sanitized: UpdateUserDto = { ...updateUserDto };

    if (user.username === defaultAdminUsername) {
      delete sanitized.username;
    }

    // 检查用户名或邮箱是否存在（排除自己）
    if (sanitized.username || sanitized.email) {
      const OR: Prisma.UserWhereInput[] = [];
      if (sanitized.username) {
        OR.push({ username: sanitized.username, id: { not: prismaId } });
      }
      if (sanitized.email) {
        OR.push({ email: sanitized.email, id: { not: prismaId } });
      }

      const exist = await this.prisma.user.findFirst({
        where: { deletedAt: null, OR },
        select: { id: true },
      });

      if (exist) {
        throw new ErrorException(ErrorExceptionCode.USER_ALREADY_EXISTS);
      }
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: prismaId },
        data: sanitized,
        select: userBaseSelect,
      });
      return updated;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        // TOCTOU：findFirst 通过后、update 前被并发软删
        throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
      }
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // TOCTOU：并发下预查通过、写入时撞唯一约束
        throw new ErrorException(ErrorExceptionCode.USER_ALREADY_EXISTS);
      }
      throw e;
    }
  }

  async updateUserSpecialRoles(
    id: string,
    { roles }: UpdateUserSpecialRolesDto,
  ): Promise<UserBasePayload> {
    // 不能修改自己的角色，除非是默认超级管理员
    const isSelf = isRequestUser(id);

    const prismaId = toBigIntId(id);

    const user = await this.prisma.user.findFirst({
      where: { id: prismaId, deletedAt: null },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    const defaultAdminUsername = this.configService.get<string>(
      'DEFAULT_ADMIN_USERNAME',
    );

    if (isSelf && user.username !== defaultAdminUsername) {
      throw new ErrorException(ErrorExceptionCode.SUPER_ADMIN_IS_SPECIAL);
    }

    try {
      return this.prisma.user.update({
        where: { id: prismaId },
        data: { specialRoles: specialRolesFromDto(roles) },
        select: userBaseSelect,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
      }
      throw e;
    }
  }

  async updateUserRoles(
    id: string,
    { roles }: UpdateUserRolesDto,
  ): Promise<UserWithFlatRoles> {
    const prismaId = toBigIntId(id);

    // 存在性先验：后面要用事务 tx 做角色校验，减少外层往返次数也便于统一错误出口
    const existing = await this.prisma.user.findFirst({
      where: { id: prismaId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    // 角色完整性校验：与 create 策略对齐——任一 code 找不到即整体失败。
    // 放在事务内：避免校验通过、写入前角色被软删导致不一致。
    return this.prisma.$transaction(async (tx) => {
      let roleIds: { id: bigint }[] = [];
      if (roles.length > 0) {
        const foundRoles = await tx.role.findMany({
          where: { code: { in: roles }, deletedAt: null },
          select: { id: true },
        });
        if (foundRoles.length !== roles.length) {
          throw new ErrorException(ErrorExceptionCode.ROLE_NOT_FOUND);
        }
        roleIds = foundRoles;
      }

      try {
        const updated = await tx.user.update({
          where: { id: prismaId },
          data: {
            roles: {
              set: roleIds.map((r) => ({
                userId_roleId: { userId: prismaId, roleId: r.id },
              })),
            },
          },
          select: userWithRolesSelect,
        });
        return flattenUserRoles(updated);
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
        }
        throw e;
      }
    });
  }

  async updatePassword({ oldPassword, newPassword }: UpdatePasswordDto) {
    // useRequestUser().id 是 Prisma.User.id → bigint
    const prismaId = useRequestUser().id as bigint;

    const user = await this.prisma.user.findFirst({
      where: { id: prismaId, deletedAt: null },
      select: { id: true, password: true },
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    const isPasswordValid = await verify(user.password, oldPassword);

    if (!isPasswordValid) {
      throw new ErrorException(ErrorExceptionCode.INVALID_CREDENTIALS);
    }

    const [hashedPassword, isSameAsOld] = await Promise.all([
      hash(newPassword, { timeCost: 5 }),
      verify(user.password, newPassword),
    ]);

    // 纳尼，居然新的密码不能和旧的密码相同
    if (isSameAsOld) {
      throw new ErrorException(ErrorExceptionCode.NEW_PASSWORD_SAME_AS_OLD);
    }

    await this.prisma.user.update({
      where: { id: prismaId },
      data: { password: hashedPassword },
      select: { id: true },
    });

    return { message: 'Password updated successfully' };
  }

  async updatePasswordByAdmin(
    id: bigint,
    { newPassword }: UpdatePasswordByAdminDto,
  ) {
    // 哈希在事务外：argon2 是 CPU 密集（timeCost=5 约 50-100ms），
    // 放进 $transaction 会拉长 DB 连接占用，与 remove 的事务粒度惯例不一致。
    const hashedPassword = await hash(newPassword, { timeCost: 5 });

    // 包事务：保证「密码重置 + 审计日志」原子性，与 remove 的 $transaction 惯例一致。
    // 设计取舍：用 updateMany + count===0 单次原子查询替代旧版 findFirst + update 两段式——
    //   - 消除 TOCTOU 窗口（旧版 findFirst 与 update 之间的并发软删/物理删无保护）
    //   - where 同时带 id 和 deletedAt: null，软删用户 count===0 被正确拦截
    //     （旧版 update 的 where 仅带 id，软删用户仍会被命中——存在安全隐患）
    //   - updateMany 对 0 行也成功，无需 try/catch P2025
    //     （与同文件 refreshToken.updateMany 的 0 行处理惯例一致）
    //   - 不区分「id 不存在」与「已被软删」——两者对调用方等价，避免信息泄露。
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: { id, deletedAt: null },
        data: { password: hashedPassword },
      });

      if (result.count === 0) {
        throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
      }

      // 操作人审计：项目无 AuditLog 服务，用 Logger 记录最小轨迹。
      // useRequestUser() 仅在请求生命周期内可用；非请求上下文（如定时任务）
      // 降级仍记目标信息，保证至少有「发生了密码重置」的可追溯线索。
      // 写法与 remove 对齐，便于跨模块统一检索。
      // 不记 newPassword / hashedPassword——敏感数据不进日志，符合 OWASP 日志纪律。
      try {
        const operator = useRequestUser();
        this.logger.log(
          `User password reset by admin: targetId=${id}, operator=${operator.id}`,
        );
      } catch {
        this.logger.log(`User password reset by admin: targetId=${id}`);
      }

      return { message: 'Password updated successfully' };
    });
  }

  async remove(id: bigint): Promise<{ success: true }> {
    // P0：禁止删除当前登录用户——管理员手滑点了自己不至于立即登出。
    if (isRequestUser(id.toString())) {
      throw new ErrorException(ErrorExceptionCode.CANNOT_DELETE_SELF);
    }

    // 包事务：保证「软删 + 审计」原子性，与 roles.service.remove 的 $transaction 惯例一致。
    // 设计取舍：放行 SuperAdmin 用户删除——上层 controller 用 @Permission(USER_DELETE)
    // 守卫，已限制只有持权限者可调用，service 层不再二次拦截角色。
    // 风险：失去「最后一名 SuperAdmin」保护，若系统最后一个超管被删，需要 SuperAdmin
    // 的路由（如 updateSpecialRoles）将无人可调用。生产建议在 controller 或单独的
    // LastSuperAdminGuard 中做计数兜底，而不是混入业务事务。
    return this.prisma.$transaction(async (tx) => {
      try {
        // 条件 UPDATE：deletedAt IS NULL，UPDATE 不匹配即抛 P2025。
        // P2025 必然意味着"id 不存在"或"已被并发软删"，不再有「角色被并发改」第三种可能，
        // 因此 catch 内无需复查 findFirst 区分语义。
        await tx.user.update({
          where: { id, deletedAt: null },
          data: { deletedAt: new Date() },
          select: { id: true },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2025'
        ) {
          // TOCTOU：调用方传入的 id 不存在或已被并发软删——两种情况对调用方等价。
          throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
        }
        throw e;
      }

      // 撤销该用户所有未过期的 RefreshToken：防止「人已删、会话仍活」——
      // access token 是无状态 JWT 无法回收，但 refresh 一旦 revoke 即不可换发新 access，
      // 等价于「最迟在当前 access 过期后强制下线」。
      // 软撤销（revokedAt）而非 deleteMany：保留审计轨迹，与 RefreshToken 模型设计一致。
      // updateMany 对 0 行也成功，无需 try/catch。
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // 关联表（UserRoles）不物理删——保留可恢复性，
      // 与 roles.service.remove 的策略一致：查询层通过 user.deletedAt 过滤脏数据。
      // 残留的 (userId, roleId) 行不会被活跃路径触达（已删用户的 userId 不再被查询），
      // 仅数据膨胀，无数据泄露。

      // 操作人审计：项目无 AuditLog 服务，用 Logger 记录最小轨迹。
      // useRequestUser() 仅在请求生命周期内可用；非请求上下文（如定时任务）
      // 降级仍记目标信息，保证至少有「发生了删除」的可追溯线索。
      // 写法与 roles.service.remove 对齐，便于跨模块统一检索。
      try {
        const operator = useRequestUser();
        this.logger.log(
          `User removed: id=${id}, operator=${operator.id}`,
        );
      } catch {
        this.logger.log(`User removed: id=${id}`);
      }

      return { success: true } as const;
    });
  }
}
