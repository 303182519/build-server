import type { User } from '@prisma/client';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { SpecialRolesEnum } from '@/common/decorators/special-roles.decorator';
import { decodeCursor } from './cursor';
import { TrendingService } from './trending.service';

@Injectable()
export class PostsService {
  // 列表缓存的 key 前缀：失效时按前缀 SCAN 清掉所有页/排序/过滤变体
  private static readonly LIST_PREFIX = 'posts:list:';
  // 单篇缓存的 key 前缀
  private static readonly POST_PREFIX = 'posts:post:id=';
  /** 构造单篇缓存 key */
  private static postKey(id: string): string {
    return `${PostsService.POST_PREFIX}${id}`;
  }
  /** 列表缓存的 SCAN MATCH pattern（不带 namespace），用于 CacheService.invalidatePattern 批量失效 */
  static readonly LIST_PATTERN = PostsService.LIST_PREFIX + '*';
  // Redis 掉线熔断：get/set 失败后进入冷却期，冷却期内请求直接 BYPASS 直连库，
  // 不重连 Redis、也不逐请求打 warn（否则掉线窗口内每个请求一条日志，造成洪泛）。
  // 冷却到期后自动重试一次，成功即恢复；再失败则重新进入冷却。
  private static readonly REDIS_COOLDOWN_MS = 30_000;
  private redisCoolDownUntil = 0;

  private readonly logger = new Logger(PostsService.name);
  // 缓存击穿守卫：同一 key 的「在途加载」共享同一个 Promise，避免高并发下打出 N 条同样的 DB 查询。
  // 这是「进程内」一层；跨进程分布式锁留待后续增强。
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(POSTS_REPOSITORY) private readonly repo: PostsRepository,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,

    @Optional() private readonly trendingService?: TrendingService,
  ) {}

  // ── 读路径：Cache-Aside（旁路缓存） ────────────────────────────────────
  // 思路就一句：「读的时候先问缓存，没有再问数据库，拿到后顺手回填缓存」。
  // 写路径（create/update/remove）负责把缓存「失效」——绝不试图去「更新」缓存（那是 Write-Through 的活，
  // 要处理并发一致性，复杂得多，收益在这个场景里不划算）。

  async findAll(query: QueryPostDto) {
    // Redis 未配置或处于掉线冷却期：绕过缓存直连库，业务不中断。
    // isRedisEnabled() 只看 store 类型，感知不到掉线；掉线靠 get/set 异常触发冷却。
    if (!this.cache.isRedisEnabled() || this.isRedisCoolingDown()) {
      setCacheState('BYPASS');
      return this.loadList(query);
    }

    const key = PostsService.listKey(query);

    // 读缓存：掉线时 get 抛异常 → 进入冷却 + 降级直连库，业务不中断
    let cached: string | undefined;
    try {
      cached = await this.cache.get<string>(key);
    } catch (err) {
      this.enterRedisCoolDown(`读取缓存失败，降级直连库 key=${key}`, err);
      setCacheState('BYPASS');
      return this.loadList(query);
    }

    if (cached) {
      setCacheState('HIT', key);
      return this.deserializeList(cached);
    }

    // 列表缓存同样用 coalesce 防击穿。TTL 带「抖动」（雪崩对策）——见 jitteredTtl。
    const result = await this.coalesce(key, () => this.loadList(query));

    // 回填缓存：掉线时 set 抛异常，但数据已拿到，跳过缓存返回结果，并进入冷却
    try {
      await this.cache.set(
        key,
        JSON.stringify(result),
        this.jitteredTtl(this.listTtl),
      );
      setCacheState('MISS', key);
    } catch (err) {
      this.enterRedisCoolDown(`回填缓存失败，跳过缓存 key=${key}`, err);
      setCacheState('BYPASS');
    }

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

  async findOne(id: string): Promise<Post> {
    // Redis 未配置或处于掉线冷却期：绕过缓存直连库
    if (!this.cache.isRedisEnabled() || this.isRedisCoolingDown()) {
      setCacheState('BYPASS');
      return this.loadById(id);
    }

    const key = `${PostsService.POST_PREFIX}${id}`;

    let cached: string | undefined;
    try {
      cached = await this.cache.get<string>(key);
    } catch (err) {
      this.enterRedisCoolDown(`读取单篇缓存失败 key=${key}`, err);
      setCacheState('BYPASS');
      return this.loadById(id);
    }

    if (cached) {
      setCacheState('HIT', key);
      return this.revivePost(JSON.parse(cached) as Post);
    }

    const post = await this.loadById(id);

    try {
      await this.cache.set(
        key,
        JSON.stringify(post),
        this.jitteredTtl(this.listTtl),
      );
      setCacheState('MISS', key);
    } catch (err) {
      this.enterRedisCoolDown(`回填单篇缓存失败 key=${key}`, err);
      setCacheState('BYPASS');
    }

    return post;
  }

  // 浏览计数 +1（原子）。不存在 → 404。
  // ★ 这里故意【不】失效单篇缓存：浏览数是低价值、强写入（每次访问都 +1）的字段，
  //   如果每次浏览都清缓存，findOne 的缓存基本就废了。我们接受 viewCount 在 TTL 内「最终一致」
  //   （最多滞后 postTtl 秒）——对「显示用」的计数完全够。这是「能接受多旧的陈旧数据」的典型权衡。
  async incrementView(id: bigint) {
    const post = await this.repo.incrementViewCount(id);
    if (!post) {
      throw new ErrorException(ErrorExceptionCode.POST_NOT_FOUND);
    }
    // 浏览数 +1 的同时，给排行榜（ZSET）也加 1 分。两处分开记：
    //   - view_count 落 DB（真相源，扛重启）
    //   - ZSET 分数（热路径，读榜用）。两者最终一致（ZSET 丢了也能从 DB 重建）。
    await this.trendingService?.bump(id);
    return post;
  }

  // 热门文章排行榜（GET /posts/trending）。
  // 先取 ZSET 的 Top N（快、不打 DB）；榜空 / Redis 不可用 → 回退到 DB 按 view_count 取（兜底）。
  async trending(limit: number): Promise<{ items: Post[] }> {
    const ids = this.trendingService
      ? await this.trendingService.top(limit)
      : [];
    if (ids.length > 0) {
      // 拿 id 后逐篇 findOne（命中单篇缓存，几乎不查库）。榜里可能挂着已删的 id → 404 跳过并清榜。
      const items: Post[] = [];
      for (const { id } of ids) {
        try {
          items.push(await this.findOne(id));
        } catch {
          await this.trendingService?.drop(id); // 榜里残留的幽灵成员，清掉
        }
        if (items.length >= limit) break;
      }
      if (items.length > 0) return { items };
    }
    // 兜底：直查 DB 按 view_count 取 Top N
    return { items: await this.repo.findTopByViewCount(limit) };
  }

  // 资源级权限——SuperAdmin 可改任意文章；其他人只能改自己写的；
  // 无主文章（authorId 空，迁移前的老数据）只有 SuperAdmin 能改。
  private assertCanModify(post: Post, user: User) {
    if (user.specialRoles === SpecialRolesEnum.SuperAdmin) return;
    if (post.authorId && post.authorId === user.id.toString()) return;
    throw new ErrorException(ErrorExceptionCode.POST_FORBIDDEN);
  }

  async remove(id: bigint, user: User) {
    // 先查出来：404 优先于 403，且要拿到 authorId 做权限判断
    const post = await this.loadById(id.toString());
    this.assertCanModify(post, user);
    const ok = await this.repo.remove(id);
    if (!ok) {
      throw new ErrorException(ErrorExceptionCode.POST_NOT_FOUND);
    }
    await this.invalidate(id.toString());
    // 从排行榜摘掉，免得榜上挂着已删文章。
    await this.trendingService?.drop(id.toString());
    return { deleted: true, id };
  }

  // 给 /posts/debug/boom 用：故意抛非 HttpException，验证全局兜底脱敏
  triggerBoom(): never {
    throw new Error('boom! 这条 message 不应该被客户端看到');
  }

  // ── Cache-Aside 的内部零件 ────────────────────────────────────────────

  private async loadById(id: string): Promise<Post> {
    const post = await this.repo.findById(BigInt(id));
    if (!post) throw new ErrorException(ErrorExceptionCode.POST_NOT_FOUND);
    return post;
  }

  // 写后失效：删单篇（精确 key）+ 清列表（按前缀）。宁可多删不可少删——缓存多留一秒 = 用户多看一秒旧数据。
  private async invalidate(postId?: string): Promise<void> {
    if (!this.cache) return;
    if (postId) await this.cache.del(PostsService.postKey(postId));
    // 一篇文章变了，所有页/排序/过滤的列表都可能受影响——按前缀全清。
    // ★ 这正是「列表缓存远不如单篇缓存划算」的根因：失效要 SCAN 扫描（单篇失效是 O(1) 的 del）。
    await this.cache.invalidatePattern(PostsService.LIST_PATTERN);
  }

  private isRedisCoolingDown(): boolean {
    return Date.now() < this.redisCoolDownUntil;
  }

  private enterRedisCoolDown(reason: string, err: unknown): void {
    this.logger.warn(
      `${reason} err=${(err as Error).message}，Redis 进入 ${PostsService.REDIS_COOLDOWN_MS}ms 冷却期`,
    );
    this.redisCoolDownUntil = Date.now() + PostsService.REDIS_COOLDOWN_MS;
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
