import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { Prisma, type Post as PrismaPost } from '@prisma/client';
import type {
  Post,
  PostMeta,
  PostStatus,
  PostWriteData,
} from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { PostsRepository, CursorResult } from './posts.repository';
import { encodeCursor, type CursorPayload } from '../cursor';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { generateSnowflakeId } from '@/shared/utils/snowflake';

/**
 * Prisma 版仓储。它做且只做一件事：把 Prisma 的行翻译成领域实体（Post），
 * 反过来把领域语言（findMany(query)）翻译成 Prisma 查询。
 *
 * 这一层就是"防腐层"：Service / Controller / DTO 永远看不到 PrismaPost、Prisma.PostWhereInput
 * 这些 ORM 概念。哪天换 Drizzle、换 TypeORM，只动这个文件。
 */
@Injectable()
export class PrismaPostsRepository implements PostsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // 列表查询统一 select：显式列出出口字段 + 通过 postTags 关联拉取标签名。
  // 抽成常量保证每个出口形状一致；satisfies 校验符合 Prisma.PostSelect。
  private static readonly postSelect = {
    id: true,
    title: true,
    slug: true,
    content: true,
    status: true,
    meta: true,
    authorId: true,
    version: true,
    viewCount: true,
    createdAt: true,
    updatedAt: true,
    postTags: { select: { tag: { select: { name: true } } } },
  } satisfies Prisma.PostSelect;

  // ── 映射：DB 行 → 领域实体 ──────────────────────────────────────────
  // 单独抽出来，保证每个出口形状一致。postTags 关联被拍平为 tags: string[]，
  // 对外不暴露 PostTag 中间表这一 ORM/DB 实现细节。
  private toDomain(
    row: Prisma.PostGetPayload<{
      select: typeof PrismaPostsRepository.postSelect;
    }>,
  ): Post {
    return {
      id: row.id.toString(),
      title: row.title,
      slug: row.slug,
      content: row.content,
      tags: row.postTags.map((pt) => pt.tag.name),
      // status 的合法值由写入路径的枚举校验保证，这里直接断言收窄回领域类型。
      status: row.status as PostStatus,
      // meta 在 DB 是可空 JSON，读出来是 Prisma.JsonValue | null，断言为领域类型。
      meta: (row.meta ?? undefined) as PostMeta | undefined,
      authorId: row.authorId?.toString() ?? undefined,
      version: row.version,
      viewCount: row.viewCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // 列表过滤条件：keyword + status + tag，抽出来供分页方法共用。
  private baseWhere(query: {
    keyword?: string;
    status?: PostStatus;
    tag?: string;
  }): Prisma.PostWhereInput {
    const where: Prisma.PostWhereInput = {};
    if (query.keyword) {
      // MySQL 默认排序规则（utf8mb4_general_ci / unicode_ci）下 contains 已不区分大小写，
      where.OR = [
        { title: { contains: query.keyword } },
        { content: { contains: query.keyword } },
      ];
    }
    if (query.status) where.status = query.status;
    // 标签通过 PostTag 多对多中间表过滤（schema 中 tags 不是数组列）。
    if (query.tag) where.postTags = { some: { tag: { name: query.tag } } };
    return where;
  }

  async findMany(
    query: QueryPostDto,
  ): Promise<{ items: Post[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';

    const where = this.baseWhere(query);

    // 不保证 total 和当页"同一时刻"；
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        select: PrismaPostsRepository.postSelect,
        // sortBy 已在 QueryPostDto 白名单校验过，动态拼 key 是安全的。
        // 追加 id 作为稳定次级排序键：主排序键相等时避免分页漂移 / 漏行 / 重复行。
        orderBy: [{ [sortBy]: order }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return { items: rows.map((r) => this.toDomain(r)), total };
  }

  // 从一行生成游标：排序字段值（日期→ISO，title→原文）+ id
  private cursorOf(row: PrismaPost, sortBy: string): string {
    const v =
      sortBy === 'title'
        ? row.title
        : row[sortBy as 'createdAt' | 'updatedAt'].toISOString();
    return encodeCursor({ v, id: row.id.toString() });
  }

  // 只把 **slug** 的唯一约束冲突（P2002 且 target 命中 slug）翻译成 409 SLUG_TAKEN。
  // 不能见 P2002 就当 slug——posts 上还有别的唯一约束（如 post_revisions 的
  // (post_id, version)），那类冲突若也报 "slug 已被占用" 就是误导。靠 e.meta.target 区分。
  private isSlugConflict(e: unknown): boolean {
    if (
      !(e instanceof Prisma.PrismaClientKnownRequestError) ||
      e.code !== 'P2002'
    ) {
      return false;
    }
    // P2002 的 meta.target 是冲突字段名数组（或约束名），slug 冲突里一定含 'slug'
    const target = (e.meta as { target?: unknown } | undefined)?.target;
    return JSON.stringify(target ?? '').includes('slug');
  }

  // 标签名唯一冲突（P2002 且 target 命中 name）：仅在并发新建同名标签时出现，
  // 用于 create 里的一次性重试——重试时标签已存在，connectOrCreate 走 connect 分支。
  private isTagNameConflict(e: unknown): boolean {
    if (
      !(e instanceof Prisma.PrismaClientKnownRequestError) ||
      e.code !== 'P2002'
    ) {
      return false;
    }
    const target = (e.meta as { target?: unknown } | undefined)?.target;
    return JSON.stringify(target ?? '').includes('name');
  }

  private slugTaken() {
    return new ErrorException(ErrorExceptionCode.SLUG_TAKEN);
  }

  // 乐观锁版本冲突（409）：期望版本与当前不一致时抛出（回滚事务）
  private versionConflict() {
    return new ErrorException(ErrorExceptionCode.VERSION_CONFLICT);
  }

  async create(data: PostWriteData): Promise<Post> {
    // 并发新建同名标签时，connectOrCreate 可能 P2002（tags.name 唯一约束）。重试一次即可：
    // 此时标签已被并发请求创建，重试的 connectOrCreate 会命中 connect 分支，不再 create。
    try {
      return await this.createOnce(data);
    } catch (e) {
      if (this.isTagNameConflict(e)) return this.createOnce(data);
      throw e;
    }
  }

  private async createOnce(data: PostWriteData): Promise<Post> {
    try {
      const row = await this.prisma.post.create({
        data: {
          // id 是 BigInt @id 且无 @default(autoincrement())，必须代码层生成雪花 ID。
          id: BigInt(generateSnowflakeId()),
          title: data.title,
          slug: data.slug,
          content: data.content,
          status: data.status,
          // 作者。Service 给登录用户的创建会带上 authorId；没传就落 NULL（无主）。
          authorId: data.authorId ? BigInt(data.authorId) : null,
          // tags 是多对多（post_tags ↔ tags），Post 上没有标量 tags 列，必须走 postTags 关联写入。
          // connectOrCreate：按 name 连接已存在标签，否则新建（name 唯一）。Service 已去重。
          ...(data.tags.length > 0
            ? {
                postTags: {
                  create: data.tags.map((name) => ({
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { id: BigInt(generateSnowflakeId()), name },
                      },
                    },
                  })),
                },
              }
            : {}),
          // meta 没传就不写这个键，让它落 DB NULL；传了才作为 JSON 写入。
          // PostMeta 是具名 interface，没有索引签名，要先经 unknown 再断言成 JSON 输入类型
          ...(data.meta !== undefined
            ? { meta: data.meta as unknown as Prisma.InputJsonValue }
            : {}),
        },
        // 和读取侧一致，用 postSelect 返回拍平后的领域实体（tags 由 postTags 拍平）。
        select: PrismaPostsRepository.postSelect,
      });
      return this.toDomain(row);
    } catch (e) {
      // slug 唯一约束是唯一可靠的防重保障（预检查存在 TOCTOU）。靠 P2002 转业务错误。
      if (this.isSlugConflict(e)) throw this.slugTaken();
      throw e;
    }
  }

  async update(
    id: bigint,
    patch: Partial<PostWriteData>,
    expectedVersion?: number,
  ): Promise<Post | null> {
    // Service 已把 undefined 过滤掉，这里只搬运确实存在的键；version 每次更新都自增。
    const data: Prisma.PostUpdateInput = { version: { increment: 1 } };
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.meta !== undefined)
      data.meta = patch.meta as unknown as Prisma.InputJsonValue;
    // tags 在 Post 上没有标量列（多对多，走 post_tags 关联），不能直接赋值。
    // 替换语义：先清空旧关联，再 connectOrCreate 新标签（写法对齐 createOnce）。
    if (patch.tags !== undefined) {
      data.postTags = {
        deleteMany: {},
        create: patch.tags.map((name) => ({
          tag: {
            connectOrCreate: {
              where: { name },
              create: { id: BigInt(generateSnowflakeId()), name },
            },
          },
        })),
      };
    }

    // 并发新建同名标签时 connectOrCreate 可能 P2002（tags.name 唯一约束），
    // 同 create：重试一次即命中 connect 分支。
    try {
      return await this.updateOnce(id, data, expectedVersion);
    } catch (e) {
      if (this.isTagNameConflict(e))
        return this.updateOnce(id, data, expectedVersion);
      throw e;
    }
  }

  // update 的事务体：改 post + 写修订快照，放进同一个交互式事务——
  // 要么都成、要么都不成（原子性）；版本冲突时在事务里 throw → 整个事务回滚，修订也不留半条。
  private async updateOnce(
    id: bigint,
    data: Prisma.PostUpdateInput,
    expectedVersion?: number,
  ): Promise<Post | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 两分支统一用 postSelect 出口形状（含 postTags 关联），和 toDomain 入参一致
        let row: Prisma.PostGetPayload<{
          select: typeof PrismaPostsRepository.postSelect;
        }>;
        if (expectedVersion !== undefined) {
          // 乐观锁：WHERE id AND version = expected（扩展 where：唯一键 + 额外过滤条件）。
          // ★ 必须用 update 而不是 updateMany：updateMany 的 data 不支持 postTags 嵌套写入，
          //   且 update 直接返回更新后的行，省一次回查。命中 0 行抛 P2025，在这区分两种原因。
          try {
            row = await tx.post.update({
              where: { id, version: expectedVersion },
              data,
              select: PrismaPostsRepository.postSelect,
            });
          } catch (e) {
            if (
              e instanceof Prisma.PrismaClientKnownRequestError &&
              e.code === 'P2025' // 要操作的记录找不到
            ) {
              // 区分"被并发删除"和"版本冲突"：再查一次
              const exists = await tx.post.findUnique({
                where: { id },
                select: { id: true },
              });
              if (!exists) return null; // 记录没了 → 交给 Service 当 NOT_FOUND
              throw this.versionConflict(); // 版本不匹配 → 409（抛出回滚事务）
            }
            throw e;
          }
        } else {
          // 不带版本：last-write-wins（最后写入者赢），但仍自增 version。
          // 记录不存在 → P2025 穿到下面的外层 catch 转 null。
          row = await tx.post.update({
            where: { id },
            data,
            select: PrismaPostsRepository.postSelect,
          });
        }

        // 同一事务里快照一条修订
        await tx.postRevision.create({
          data: {
            // id 是 BigInt @id 且无 @default（雪花 ID 代码层生成，对齐 posts 主表惯例）
            id: BigInt(generateSnowflakeId()),
            postId: row.id,
            version: row.version,
            title: row.title,
            content: row.content,
          },
        });
        return this.toDomain(row);
      });
    } catch (e) {
      // P2025（不带版本、记录不存在）→ null；P2002（改 slug 撞名竞态）→ 409 SLUG_TAKEN
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return null;
      }
      if (this.isSlugConflict(e)) throw this.slugTaken();
      throw e;
    }
  }

  async findByCursor(
    query: QueryPostDto,
    cursor: CursorPayload | null,
  ): Promise<CursorResult> {
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';
    // desc 想要"排在游标后面"= 比游标更小的行；asc 则是更大的行
    const op = order === 'asc' ? 'gt' : 'lt';

    const where = this.baseWhere(query);

    if (cursor) {
      // 游标分页（keyset pagination）的核心：把"排在游标之后的那些行"翻译成一个过滤条件，
      // 再配合 orderBy + take 直接取下一页，替代 offset/skip 的分页方式。
      // 游标存的是排序字段值（date→ISO 字符串，title→原文）+ id，见 cursorOf()。
      //
      // 具体例子：按 createdAt desc 排序，游标指向某一行
      //   { createdAt: '2026-09-02T10:00:00Z', id: '100' }
      // 则"排在它后面"的行只有两类，下面两个 OR 分支一一对应：
      //   ① 更早的行：createdAt < 10:00
      //   ② 同一时刻但 id 更小的行：createdAt = 10:00 且 id < 100
      // 这正对应 orderBy [{ createdAt: 'desc' }, { id: 'desc' }] 的方向。
      //
      // 这里要把值还原成能被 Prisma 比较的类型：title 是字符串直接用，日期字段则还原成 Date。
      const v = sortBy === 'title' ? cursor.v : new Date(cursor.v);
      const keyset = {
        OR: [
          /* 
            (created_at, id) < (X, Y)
            ⟺  created_at < X                       -- 严格更小
                OR (created_at = X AND id < Y)        -- 打平时看 id 
          */
          // 条件一：排序字段值严格"越过"游标（asc 取更大 gt，desc 取更小 lt）。
          { [sortBy]: { [op]: v } },
          // 条件二：排序字段值刚好等于游标时，用 id 作为次级键继续比较。
          // [sortBy]: v 是相等判断；这样排序字段有重复值时，靠 id 也能稳定翻页，不重不漏。
          { [sortBy]: v, id: { [op]: cursor.id } },
        ],
      };
      // baseWhere 里 keyword 已经用过顶层 OR，keyset 若再写顶层 OR 会互相覆盖；
      // 所以把 keyset 放进 AND 分支，让"关键词过滤"和"游标定位"两个 OR 各自生效后再取交集。
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), keyset];
    }

    // 多取一条：用来判断"还有没有下一页"，这一条不返回给客户端
    const rows = await this.prisma.post.findMany({
      where,
      select: PrismaPostsRepository.postSelect,
      orderBy: [
        { [sortBy]: order },
        { id: order }, // 次级键方向要和主键一致，keyset 才自洽
      ],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? this.cursorOf(page[page.length - 1], sortBy)
        : null;

    return { items: page.map((r) => this.toDomain(r)), nextCursor };
  }

  async findById(id: bigint): Promise<Post | null> {
    const row = await this.prisma.post.findUnique({
      where: { id },
      select: PrismaPostsRepository.postSelect,
    });
    return row ? this.toDomain(row) : null;
  }

  async findTopByViewCount(limit: number): Promise<Post[]> {
    const rows = await this.prisma.post.findMany({
      where: { status: 'published' },
      select: PrismaPostsRepository.postSelect,
      orderBy: [{ viewCount: 'desc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((r) => this.toDomain(r));
  }

  async incrementViewCount(id: bigint): Promise<Post | null> {
    // 原子自增：没有"读-改-写"竞态，不需要乐观锁 / 行锁。
    // ★ 故意走裸 SQL 而不是 prisma.post.update：浏览不是内容变更，不该改 updated_at。
    //   而 Prisma 的 @updatedAt 会在**任何** update/updateMany 时把 updated_at 设成 now()，
    //   那样既不符合语义，还会让 sortBy=updatedAt 的游标分页因为浏览而漂移。
    //   裸 SQL 绕开 @updatedAt；$executeRaw 返回受影响行数，0 = 记录不存在。
    const affected = await this.prisma.$executeRaw`
      UPDATE posts SET view_count = view_count + 1
      WHERE id = ${id}
    `;
    if (affected === 0) return null;
    // 标签是多对多关系（post_tags 中间表），裸 SQL 的 RETURNING 拿不到 postTags 关联；
    // 复用 findById 按 postSelect 拉全量并 toDomain，保证返回形状与其它出口一致。
    return this.findById(id);
  }

  async remove(id: bigint): Promise<boolean> {
    try {
      await this.prisma.post.delete({ where: { id } });
      return true;
    } catch (e) {
      // 删一条不存在的记录 → P2025 → 返回 false（和内存版 Map.delete 的语义对齐）
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return false;
      }
      throw e;
    }
  }
}
