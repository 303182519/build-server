import type { Post, PostWriteData, PostRevision } from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';
import type { CursorPayload } from '../cursor';

// 游标分页的返回：当页数据 + 下一页游标（null 表示没有下一页了）
export interface CursorResult {
  items: Post[];
  nextCursor: string | null;
}

// 用 Symbol 做 DI token，避免和字符串 token 撞名
// Service 通过 @Inject(POSTS_REPOSITORY) 拿到实现
export const POSTS_REPOSITORY = Symbol('POSTS_REPOSITORY');

// 仓储接口：业务语言（findMany），不出现 ORM 概念（whereClause / orderBy 数组）
// 所有方法返回 Promise —— 换 Prisma/其他实现时调用方零改动
export interface PostsRepository {
  create(data: PostWriteData): Promise<Post>;

  // offset 分页（GET /posts）：返回当页 + 总数。能跳任意页，但深翻慢、并发下会漂移。
  findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }>;

  // 游标 / keyset 分页（GET /posts/feed）：只能顺序往下翻，但稳定、深翻不掉速。
  findByCursor(
    query: QueryPostDto,
    cursor: CursorPayload | null,
  ): Promise<CursorResult>;

  // 按 ID 查单篇。不存在返回 null，调用方决定抛 404 还是静默跳过。
  findById(id: bigint): Promise<Post | null>;

  // 热门排行榜 DB 兆底：按浏览数降序取 Top N（仅 published）。
  findTopByViewCount(limit: number): Promise<Post[]>;

  // 浏览计数原子自增（可交换操作，无需乐观锁 / 行锁）。返回 null = 记录不存在。
  incrementViewCount(id: bigint): Promise<Post | null>;

  remove(id: bigint): Promise<boolean>;

  // Day 29 —— 列出某篇文章的修订历史（新 → 旧）。
  listRevisions(postId: bigint): Promise<PostRevision[]>;

  // Day 29 —— 更新。expectedVersion 提供时做乐观锁检查（版本不匹配抛 VERSION_CONFLICT）；
  // 无论是否提供，成功更新都自增 version，并在同一事务里写一条修订快照。
  // 返回 null = 记录不存在。
  update(
    id: bigint,
    patch: Partial<PostWriteData>,
    expectedVersion?: number,
  ): Promise<Post | null>;
}
