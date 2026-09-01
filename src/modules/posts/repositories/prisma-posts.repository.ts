import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import {
  Prisma,
  type Post as PrismaPost,
  type PostRevision as PrismaRevision,
} from '@prisma/client';
import type {
  Post,
  PostMeta,
  PostRevision,
  PostStatus,
  PostWriteData,
} from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { PostsRepository } from './posts.repository';
/**
 * Prisma 版仓储。它做且只做一件事：把 Prisma 的行（PrismaPost）翻译成领域实体（Post），
 * 反过来把领域语言（findBySlug / findMany(query)）翻译成 Prisma 查询。
 *
 * 这一层就是"防腐层"：Service / Controller / DTO 永远看不到 PrismaPost、Prisma.PostWhereInput
 * 这些 ORM 概念。哪天换 Drizzle、换 TypeORM，只动这个文件。
 *
 * ★ 注意它和 InMemoryPostsRepository 实现的是同一个接口 PostsRepository。
 *   posts.module.ts 把 POSTS_REPOSITORY 这个 token 从 InMemory 换成它——Service 一行不改。
 */
@Injectable()
export class PrismaPostsRepository implements PostsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── 映射：DB 行 → 领域实体 ──────────────────────────────────────────
  // 单独抽出来，保证每个出口（findById/findBySlug/findMany/create/update）形状一致
  private toDomain(row: PrismaPost): Post {
    return {
      id: row.id.toString(),
      title: row.title,
      slug: row.slug,
      content: row.content,
      tags: row.tags,
      // status / meta 是 DB 端的"宽类型"，这里收窄回领域类型。
      // status 的合法值由写入路径（CreatePostDto 的枚举校验）保证，所以直接断言。
      status: row.status as PostStatus,
      // meta 在 DB 是可空 JSONB，读出来是 Prisma.JsonValue | null。
      // 生产代码这里应该用 Zod 再校验一次（见 Day 26 §JSON 不安全），demo 先直接断言。
      meta: (row.meta ?? undefined) as PostMeta | undefined,
      authorId: row.authorId?.toString() ?? undefined,
      version: row.version,
      viewCount: row.viewCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // DB 修订行 → 领域修订
  private toRevision(row: PrismaRevision): PostRevision {
    return {
      id: row.id.toString(),
      postId: row.postId.toString(),
      version: row.version,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt,
    };
  }

  // 列表 / 游标都用得到的过滤条件：keyword(ILIKE) + status + tag。抽出来给两个分页方法共用。
  private baseWhere(query: {
    keyword?: string;
    status?: PostStatus;
    tag?: string;
  }): Prisma.PostWhereInput {
    const where: Prisma.PostWhereInput = {};
    if (query.keyword) {
      // 关键字匹配 title 或 content，不区分大小写（PG ILIKE）
      where.OR = [
        { title: { contains: query.keyword, mode: 'insensitive' } },
        { content: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    if (query.status) where.status = query.status;
    // tags 是数组列：has 等价于 SQL 的 'tag' = ANY(tags)
    if (query.tag) where.tags = { has: query.tag };
    return where;
  }

  async findMany(
    query: QueryPostDto,
  ): Promise<{ items: Post[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'desc';

    // 把 DTO 翻译成 Prisma 的 where——keyword(ILIKE) / status / tag，下推到 PG
    const where = this.baseWhere(query);

    // ★ count 和 findMany 包进 $transaction 数组（Day 26）：两条查询在同一个事务、
    //   一次往返里执行。但注意没传 isolationLevel，默认是 Read Committed——
    //   每条语句各取一次快照，所以这 *并不* 保证 total 和当页"同一时刻"。
    //   要让两者绝对一致，得加 isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead。
    //   列表接口通常不值得为此上 RR；这里用数组事务图的是少一次往返 + 语义清晰（见 README §7）。
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        // sortBy 已在 QueryPostDto 白名单校验过，这里动态拼 key 是安全的。
        // 追加 id 作为稳定的次级排序键：主键（如 createdAt）相等时 PG 返回顺序本是
        // 未定义的，补 id 让分页在多页之间稳定、可重现，避免漏行 / 重复行。
        orderBy: [
          { [sortBy]: order } as Prisma.PostOrderByWithRelationInput,
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return { items: rows.map((r) => this.toDomain(r)), total };
  }
}