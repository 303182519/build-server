import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { Prisma, type Post as PrismaPost } from '@prisma/client';
import type { Post, PostMeta, PostStatus } from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { PostsRepository, CursorResult } from './posts.repository';
import { encodeCursor, type CursorPayload } from '../cursor';

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
}
