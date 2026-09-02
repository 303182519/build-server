import type { Post } from '../entities/post.entity';
import type { QueryPostDto } from '../dto/query-post.dto';

// 用 Symbol 做 DI token，避免和字符串 token 撞名
// Service 通过 @Inject(POSTS_REPOSITORY) 拿到实现
export const POSTS_REPOSITORY = Symbol('POSTS_REPOSITORY');

// 仓储接口：业务语言（findMany），不出现 ORM 概念（whereClause / orderBy 数组）
// 所有方法返回 Promise —— 换 Prisma/其他实现时调用方零改动
export interface PostsRepository {
  // offset 分页（GET /posts）：返回当页 + 总数。能跳任意页，但深翻慢、并发下会漂移。
  findMany(query: QueryPostDto): Promise<{ items: Post[]; total: number }>;
}
