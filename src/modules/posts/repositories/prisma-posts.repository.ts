import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import type {
  Post,
  PostMeta,
  PostStatus,
} from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { PostsRepository } from './posts.repository';

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
