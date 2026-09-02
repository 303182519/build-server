import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Post } from './entities/post.entity';
import { QueryPostDto } from './dto/query-post.dto';
import { setCacheState } from '@/common/request-context';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { CacheService } from '@/shared/caching/cache.service';
import { getConfig } from '@/config/configuration';
import {
  POSTS_REPOSITORY,
  type PostsRepository,
} from './repositories/posts.repository';
import { decodeCursor } from './cursor';

@Injectable()
export class PostsService {

	// 列表缓存的 key 前缀：失效时按前缀 SCAN 清掉所有页/排序/过滤变体
  private static readonly LIST_PREFIX = 'posts:list:';
	/** 列表缓存的 SCAN MATCH pattern（不带 namespace），用于 CacheService.invalidatePattern 批量失效 */
  static readonly LIST_PATTERN = PostsService.LIST_PREFIX + '*';
	// 缓存击穿守卫：同一 key 的「在途加载」共享同一个 Promise，避免高并发下打出 N 条同样的 DB 查询。
  // 这是「进程内」一层；跨进程分布式锁留待后续增强。
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(POSTS_REPOSITORY) private readonly repo: PostsRepository,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
  ) {}

  // ── 读路径：Cache-Aside（旁路缓存） ────────────────────────────────────
  // 思路就一句：「读的时候先问缓存，没有再问数据库，拿到后顺手回填缓存」。
  // 写路径（create/update/remove）负责把缓存「失效」——绝不试图去「更新」缓存（那是 Write-Through 的活，
  // 要处理并发一致性，复杂得多，收益在这个场景里不划算）。

  async findAll(query: QueryPostDto) {
    // Redis 不可用（未配置 / 掉线）：绕过缓存直连库，业务不中断
    if (!this.cache.isRedisEnabled()) {
      setCacheState('BYPASS');
      return this.loadList(query);
    }
    const key = PostsService.listKey(query);
    const cached = await this.cache.get<string>(key);
    if (cached) {
      setCacheState('HIT', key);
      return this.deserializeList(cached);
    }
    // 列表缓存同样用 coalesce 防击穿。TTL 带「抖动」（雪崩对策）——见 jitteredTtl。
    const result = await this.coalesce(key, () => this.loadList(query));
    await this.cache.set(key, JSON.stringify(result), this.jitteredTtl(this.listTtl));
    setCacheState('MISS', key);
    return result;
  }

  // 游标分页（GET /posts/feed）：解码游标 → 查 keyset → 回 nextCursor。
  // ★ 不缓存：游标 token 的基数几乎是「无限」（每次翻页一个新 token），缓存命中率趋近 0，
  //   还要处理失效——典型的「不该缓存」场景。见 README「哪些数据不该缓存」。
  async feed(query: QueryPostDto) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    // 传了 cursor 却解不出来 → 不是"第一页"，是非法输入，直接 400（别静默当第一页）
    if (query.cursor && !cursor) {
      throw new ErrorException(ErrorExceptionCode.INVALID_CURSOR);
    }
    const { items, nextCursor } = await this.repo.findByCursor(query, cursor);
    return {
      items,
      // 游标分页不返回 total / page：要么算不准、要么代价高，且客户端也用不上
      pageInfo: {
        nextCursor,
        hasMore: nextCursor !== null,
        limit: query.limit ?? 20,
      },
    };
  }



	private async loadList(query: QueryPostDto) {
    const { items, total } = await this.repo.findMany(query);
    return {
      items,
      pagination: {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        total,
      },
    };
  }

	// 缓存击穿守卫：同一 key 的并发加载只触发一次真正的 loader，其余调用复用同一个 Promise。
  // 利用 JS 单线程特性——get 与 set 之间没有 await，不会被其它微任务插队，所以不会漏。
  private async coalesce<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = loader().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

	// 把查询参数稳定序列化成 list 缓存 key。
  // ★ 字段顺序固定：否则 {a:1,b:2} 和 {b:2,a:1} 会被当成两个 key，等于没缓存。
  //   明文保留方便 redis-cli 调试；生产 key 过长/含特殊字符时一般再套一层 sha256 哈希。
  private static listKey(query: QueryPostDto): string {
    const normalized = JSON.stringify({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      sortBy: query.sortBy ?? 'createdAt',
      order: query.order ?? 'desc',
      keyword: query.keyword ?? '',
      tag: query.tag ?? '',
      status: query.status ?? '',
    });
    return `${PostsService.LIST_PREFIX}${normalized}`;
  }

	private get listTtl(): number {
    return getConfig(this.configService).redis.defaultTtl;
  }

	// 雪崩对策——给 TTL 加随机抖动，错开同一批回填 key 的过期时刻。
  // 否则「一次性预热」的大量 key 会在同一秒集体过期 → 同一瞬间全部 miss → DB 被集中轰击（雪崩）。
  // 抖动幅度取 base 的 10%（至少 10 秒），不引入额外配置项，复用全局 redis.defaultTtl。
  private jitteredTtl(base: number): number {
    const jitter = Math.max(10, Math.floor(base * 0.1));
    return base + Math.floor(Math.random() * (jitter + 1));
  }

	private revivePost(p: Post): Post {
    return {
      ...p,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    };
  }

	private deserializeList(raw: string): {
    items: Post[];
    pagination: { page: number; limit: number; total: number };
  } {
    const obj = JSON.parse(raw) as {
      items: Post[];
      pagination: { page: number; limit: number; total: number };
    };
    return {
      items: obj.items.map((p) => this.revivePost(p)),
      pagination: obj.pagination,
    };
  }
}
