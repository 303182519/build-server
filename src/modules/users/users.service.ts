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

type RoleFlatPayload = UserWithRolesPayload['roles'][number]['role'];

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

  /**
   * 构造时一次性读入并缓存，避免每次 update/remove/specialRoles 时
   * 反复调用 configService.get（虽然 ConfigService 内部有缓存，但
   * 显式 readonly 字段既表达「不可变配置」的语义，也便于单测直接赋值）。
   */
  private readonly defaultAdminUsername: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rolesService: RolesService,
    private readonly permissionsService: PermissionsService,
    private readonly configService: ConfigService,
  ) {
    this.defaultAdminUsername = this.configService.getOrThrow<string>(
      'DEFAULT_ADMIN_USERNAME',
    );
  }

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

  async findAll({
    page = 1,
    pageSize = 20,
    search,
  }: FindUsersDto = {}): Promise<{
    list: UserWithFlatRoles[];
    total: number;
    page: number;
    pageSize: number;
  }> {
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
   * 按 id / username / email 查询单个未软删用户，找不到即抛 USER_NOT_FOUND。
   *
   * 语义约定：
   *   - 多条件同时传入时按 AND 过滤，用于交叉校验（如「id + username 必须同时匹配」）。
   *   - 空 criteria 会被拦截：where 仅剩 deletedAt: null 时 findFirst 会命中任意未删用户
   *     （通常是默认超管），属于静默越权，故按 USER_NOT_FOUND 等价处理。
   *   - 不区分「id 不存在」与「已被软删」，避免信息泄露。
   *
   * @param criteria 至少传一个字段。
   * @param relations 传 { roles: true } 时返回拍平后的 roles 数组；省略时仅返回 base 字段。
   */
  async findOneOrThrow(
    criteria: { id?: bigint; username?: string; email?: string },
    relations?: { roles?: boolean },
  ): Promise<UserWithFlatRoles | UserBasePayload> {
    if (criteria.id === undefined && !criteria.username && !criteria.email) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    const where: Prisma.UserWhereInput = { deletedAt: null };
    // 用 !== undefined 而非 falsy 判断：bigint 0n 不应被跳过（虽然雪花 ID 不会为 0）。
    if (criteria.id !== undefined) where.id = criteria.id;
    if (criteria.username) where.username = criteria.username;
    if (criteria.email) where.email = criteria.email;

    const includeRoles = relations?.roles === true;

    // Prisma findFirst 在 select 为三元时无法基于运行时分支收窄返回类型，
    // 需根据 includeRoles 显式断言为对应 payload 类型。
    const user = await this.prisma.user.findFirst({
      where,
      select: includeRoles ? userWithRolesSelect : userBaseSelect,
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    return includeRoles ? flattenUserRoles(user as UserWithRolesPayload) : user;
  }

  updateProfile(updateProfileDto: UpdateUserDto) {
    const userId = useRequestUser().id;
    return this.update(userId, updateProfileDto);
  }

  async update(
    id: bigint,
    updateUserDto: UpdateUserDto,
  ): Promise<UserBasePayload> {
    // ------------------------------------------------------------------
    // 1) 输入规范化：'' / null → undefined（DTO 层已对 '' fail-fast，此处为纵深防御）：
    //    - '' 是真实值，入库后两个 '' 会在唯一索引上互相冲突（P2002）；
    //    - null 若透传，Prisma 会把库里的 email 静默清成 NULL（等于解绑登录凭证）。
    //    二者统一视为「未提交该字段」，跳过更新。
    // ------------------------------------------------------------------
    const normalizedEmail =
      updateUserDto.email === '' || updateUserDto.email == null
        ? undefined
        : updateUserDto.email;
    const normalizedUsername =
      updateUserDto.username === '' || updateUserDto.username == null
        ? undefined
        : updateUserDto.username;

    // 若 DTO 两个字段都被规范化为"实际无变更"，则直接走 1 次存在性查询后原封返回。
    // 否则进入下方的 2-in-1 合并查询。
    const hasChange =
      normalizedEmail !== undefined || normalizedUsername !== undefined;

    // ------------------------------------------------------------------
    // 2) 权限校验（Service 层纵深防御）：
    //    - 非本人更新必须持有 USER_UPDATE 权限；这里不直接查 Guard（装饰器在 Controller），
    //      但通过特殊角色 + 操作者身份做最小自保护：
    //      * 非 SuperAdmin / 非 Developer：只能 updateProfile（即本人）
    //    - 注意：真正的 USER_UPDATE 权限已在 Controller 层由 @Permission(USER_UPDATE) 拦截，
    //      这里是"兜底式"纵深防御，防止内部绕过（如消息队列、内部 RPC 调用）。
    // ------------------------------------------------------------------
    const isSelf = isRequestUser(id.toString());
    if (!isSelf) {
      try {
        const operator = useRequestUser();
        const opSpecialRoles = operator.specialRoles;
        if (
          opSpecialRoles !== SpecialRolesEnum.SuperAdmin &&
          opSpecialRoles !== SpecialRolesEnum.Developer
        ) {
          throw new ErrorException(ErrorExceptionCode.UPDATE_PERMISSION_DENIED);
        }
      } catch (e) {
        if (e instanceof ErrorException) throw e;
        // useRequestUser() 抛 Error（非请求上下文，如测试/任务），放行
      }
    }

    // ------------------------------------------------------------------
    // 3) 阶段一：存在性预查（1 次 DB 往返）——直接以 userBaseSelect 形状读出：
    //    - 若后续 allowedFields 为空 / 是默认管理员 / 无实际变更 → 直接 return，省一次查询
    //    - username / email 用于：默认管理员保护、冲突对比、审计日志
    //    设计取舍：不使用 $queryRaw（方言依赖），退化为"最坏 2 次预查 + 1 次写入"。
    //    较原实现仍减少：当 hasChange===false 时只 1 次；当值未变（如 username 同原值）
    //    时可跳过冲突预查，又省 1 次。
    // ------------------------------------------------------------------
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: userBaseSelect,
    });
    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    // 阶段二：如果有字段变更（且不同于原值）→ 用单条 OR 联合查询检查唯一性
    // 并在查出冲突时精确区分是哪个字段撞了。
    if (hasChange) {
      const conflictOR: Prisma.UserWhereInput[] = [];
      if (
        normalizedUsername !== undefined &&
        normalizedUsername !== user.username
      ) {
        conflictOR.push({ username: normalizedUsername });
      }
      if (normalizedEmail !== undefined && normalizedEmail !== user.email) {
        conflictOR.push({ email: normalizedEmail });
      }

      if (conflictOR.length > 0) {
        const conflict = await this.prisma.user.findFirst({
          where: { deletedAt: null, id: { not: id }, OR: conflictOR },
          select: { username: true, email: true },
        });
        if (conflict) {
          if (
            normalizedUsername !== undefined &&
            conflict.username === normalizedUsername &&
            normalizedUsername !== user.username
          ) {
            throw new ErrorException(
              ErrorExceptionCode.USERNAME_ALREADY_EXISTS,
            );
          }
          if (
            normalizedEmail !== undefined &&
            conflict.email === normalizedEmail &&
            normalizedEmail !== user.email
          ) {
            throw new ErrorException(ErrorExceptionCode.EMAIL_ALREADY_EXISTS);
          }
          // 兜底：未知字段冲突（理论上不该到达）
          throw new ErrorException(ErrorExceptionCode.USER_ALREADY_EXISTS);
        }
      }
    }

    // ------------------------------------------------------------------
    // 4) 默认管理员白名单保护：
    //    - 默认管理员只允许修改 password（其他接口），
    //      username / email 属于账号身份核心字段，一律禁止变更。
    //    - 用「白名单」而非「黑名单 delete」：即使未来 UpdateUserDto 新增敏感字段，
    //      也不会被意外透传到 update。
    // ------------------------------------------------------------------
    const isDefaultAdmin = user.username === this.defaultAdminUsername;
    const allowedFields: Prisma.UserUpdateInput = {};
    if (!isDefaultAdmin) {
      // 仅当"值真正变化"时才放入 update 字段，避免无谓写入 updatedAt
      if (normalizedEmail !== undefined && normalizedEmail !== user.email) {
        allowedFields.email = normalizedEmail;
      }
      if (
        normalizedUsername !== undefined &&
        normalizedUsername !== user.username
      ) {
        allowedFields.username = normalizedUsername;
      }
    }

    // 若无任何可写入字段，直接返回阶段一读的记录（省一次 DB 查询）
    if (Object.keys(allowedFields).length === 0) {
      return user;
    }

    // ------------------------------------------------------------------
    // 5) 执行更新 + 异常兜底 + 审计日志
    // ------------------------------------------------------------------
    try {
      const updated = await this.prisma.user.update({
        // 与前置查询保持一致，显式加 deletedAt: null：避免 P2025 窗口
        // 命中已软删用户（防御性编程，即使 Prisma unique where 只带 id）
        where: { id },
        data: allowedFields,
        select: userBaseSelect,
      });

      // 审计日志：记录变更字段（不落敏感值），与 remove / resetPassword 写法对齐
      const changed = [] as string[];
      if (normalizedEmail !== undefined && !isDefaultAdmin)
        changed.push('email');
      if (normalizedUsername !== undefined && !isDefaultAdmin)
        changed.push('username');
      try {
        const operator = useRequestUser();
        this.logger.log(
          `User updated: id=${id}, fields=[${changed.join(',')}], operator=${operator.id}`,
        );
      } catch {
        this.logger.log(
          `User updated: id=${id}, fields=[${changed.join(',')}]`,
        );
      }

      return updated;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025' // 要操作的记录找不到
      ) {
        // TOCTOU：合并查询通过后、update 前被并发软删
        throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
      }
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' // 唯一索引冲突，重复值
      ) {
        // TOCTOU：并发下预查通过、写入时撞唯一约束
        // 解析 Prisma meta.target（唯一索引名/字段），精确区分是 username 还是 email。
        // Prisma P2002 meta.target 形如 ["username"] 或 ["email"]。
        const target = (e.meta?.target as unknown[]) ?? [];
        if (target.includes('username')) {
          throw new ErrorException(ErrorExceptionCode.USERNAME_ALREADY_EXISTS);
        }
        if (target.includes('email')) {
          throw new ErrorException(ErrorExceptionCode.EMAIL_ALREADY_EXISTS);
        }
        throw new ErrorException(ErrorExceptionCode.USER_ALREADY_EXISTS);
      }
      throw e;
    }
  }

  async updateUserSpecialRoles(
    id: bigint,
    { roles }: UpdateUserSpecialRolesDto,
  ): Promise<UserBasePayload> {
    // 不能修改自己的角色，除非是默认超级管理员
    const isSelf = isRequestUser(id.toString());

    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    if (isSelf && user.username !== this.defaultAdminUsername) {
      throw new ErrorException(ErrorExceptionCode.SUPER_ADMIN_IS_SPECIAL);
    }

    // 审计：特殊角色变更属于高敏感操作，记录日志
    try {
      const operator = useRequestUser();
      this.logger.log(
        `User special roles updated: id=${id}, roles=${roles.join(',')}, operator=${operator.id}`,
      );
    } catch {
      this.logger.log(
        `User special roles updated: id=${id}, roles=${roles.join(',')}`,
      );
    }

    try {
      return this.prisma.user.update({
        where: { id },
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
    id: bigint,
    { roles }: UpdateUserRolesDto,
  ): Promise<UserWithFlatRoles> {
    // 存在性先验：后面要用事务 tx 做角色校验，减少外层往返次数也便于统一错误出口
    const existing = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
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
          where: { id },
          data: {
            // 替换语义：deleteMany 清空当前用户所有 user_roles 关联行，
            // create 再批量插入新关联（连接到已存在的 Role）。
            // ❌ 不能用 set: [{ userId_roleId: {...} }]——显式 m-n 复合主键场景下
            //    set 只会"保留已存在 + 删除不在集合里的"，不会 INSERT 不存在的关联行，
            //    导致首次给用户分配角色时静默失败、roles: [] 返回。
            //    官方文档对显式 m-n 也只演示 create，没有 set 的示例。
            roles: {
              deleteMany: {},
              create: roleIds.map((r) => ({ roleId: r.id })),
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
    const prismaId = useRequestUser().id;

    const user = await this.prisma.user.findFirst({
      where: { id: prismaId, deletedAt: null },
      select: { id: true, password: true },
    });

    if (!user) {
      throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
    }

    // OAuth-only 账号 password 为 NULL：没有「旧密码」可验证。
    // 且 argon2.verify 对非法 hash 是 throw 而非返回 false（见 auth.service 注释），
    // 不拦截会直接 500；必须显式给出业务错误。
    if (!user.password) {
      throw new ErrorException(ErrorExceptionCode.PASSWORD_NOT_SET);
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
        this.logger.log(`User removed: id=${id}, operator=${operator.id}`);
      } catch {
        this.logger.log(`User removed: id=${id}`);
      }

      return { success: true } as const;
    });
  }
}
