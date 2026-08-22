import { isRequestUser, useRequestUser } from '@/common/context/user-context';
import { SpecialRolesEnum } from '@/common/decorators/special-roles.decorator';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
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
    // useRequestUser() 返回 Prisma.User，其 id 是 BigInt。
    const userId = useRequestUser().id as bigint;

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: userWithRolesSelect,
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    return flattenUserRoles(user);
  }

  async getPermissions(userId?: string) {
    const id = userId ?? (useRequestUser().id as bigint).toString();

    const roles = await this.rolesService.findByUser(id);

    // 使用 Prisma 原生多对多过滤（走 rolePermissions 中间表），
    // 替代旧 TypeORM 版 `where: { roles: { id: In(...) } }` 的嵌套风格。
    return this.permissionsService.findMany({
      where: {
        rolePermissions: {
          some: {
            roleId: { in: roles.map((role) => role.id) },
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

  /**
   * 公共 findOne：与旧 TypeORM 版签名保持形状兼容——
   * criteria 目前只消费 `id`（controller / jwt-auth.strategy 都传 { id }）。
   * relations 旧版传 { roles: true }，新版用 `includeRoles` 语义。
   */
  async findOne(
    criteria: { id?: string | bigint; username?: string; email?: string },
    relations?: { roles?: boolean } | string[] | Prisma.UserInclude,
  ): Promise<any> {
    const includeRoles =
      typeof relations === 'object' &&
      relations !== null &&
      'roles' in relations &&
      (relations as { roles?: boolean }).roles === true;

    let prismaId: bigint | undefined;
    if (criteria.id !== undefined) {
      prismaId =
        typeof criteria.id === 'bigint'
          ? criteria.id
          : toBigIntId(criteria.id as string);
    }

    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (prismaId !== undefined) where.id = prismaId;
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
    id: string,
    { newPassword }: UpdatePasswordByAdminDto,
  ) {
    const prismaId = toBigIntId(id);

    const user = await this.prisma.user.findFirst({
      where: { id: prismaId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    const hashedPassword = await hash(newPassword, {
      timeCost: 5,
    });

    try {
      await this.prisma.user.update({
        where: { id: prismaId },
        data: { password: hashedPassword },
        select: { id: true },
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

    return { message: 'Password updated successfully' };
  }

  async remove(id: bigint): Promise<UserBasePayload> {


    const user = await this.prisma.user.findFirst({
      where: { id: id, deletedAt: null },
      select: { id: true, specialRoles: true, username: true },
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    // 如果用户是超级管理员，则不能删除
    if (user.specialRoles === SpecialRolesEnum.SuperAdmin) {
      throw new ErrorException(ErrorExceptionCode.SUPER_ADMIN_IS_SPECIAL);
    }

    try {
      const removed = await this.prisma.user.update({
        where: { id: id },
        data: { deletedAt: new Date() },
        select: userBaseSelect,
      });
      return removed;
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
}
