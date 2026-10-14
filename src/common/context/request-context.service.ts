import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { User } from '@prisma/client';
import type { AppClsStore, CacheState } from './cls-store';

/**
 * 请求上下文门面（ADR-005）。
 *
 * 这是全应用访问请求上下文（CLS）的**唯一入口**：业务代码 / 拦截器 / 过滤器都应注入本门面，
 * 而不是直接依赖 nestjs-cls 的 `ClsService` 字符串 key，避免上下文 key 在 30+ 处散落。
 *
 * 语义与迁移前的手写实现严格对齐：
 * - 「读」在无上下文时返回 undefined（不抛）；
 * - requireUser() 在无用户时抛错（沿用原错误语义，供业务 try/catch 降级）；
 * - 「写」在无上下文时静默忽略（降级哲学不变）；
 * - user 由 UserContextInterceptor 在 JWT 守卫之后写入；
 * - requestId 由 ClsMiddleware 的 generateId/idGenerator 生成，经 `cls.getId()` 读取。
 */
@Injectable()
export class RequestContextService {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  /** 读当前请求用户；无则返回 undefined。 */
  getUser(): User | undefined {
    return this.cls.get('user');
  }

  /**
   * 读当前请求用户；无用户时抛错。
   *
   * 保留「抛出」语义：非请求上下文（单元测试直接调 service、定时任务等）调用时抛 Error，
   * 由调用方以既有 try/catch 结构降级。
   */
  requireUser(): User {
    const user = this.getUser();
    if (!user) {
      throw new Error(
        'RequestContextService.requireUser() can only be used within a request lifecycle.',
      );
    }
    return user;
  }

  /** 判断某个 id 是否为当前请求用户（无上下文时抛出，保持既有行为）。 */
  isRequestUser(userId: string): boolean {
    return userId === this.requireUser().id.toString();
  }

  /** 写入当前请求用户；无上下文时静默忽略（如 WebSocket 路径）。 */
  setUser(user: User): void {
    if (!this.cls.isActive()) return;
    this.cls.set('user', user);
  }

  /** 读缓存命中状态。 */
  getCacheState(): { cache?: CacheState; cacheKey?: string } {
    return {
      cache: this.cls.get('cache'),
      cacheKey: this.cls.get('cacheKey'),
    };
  }

  /** service 用：写入这次读的缓存命中状态；无上下文时静默忽略。 */
  setCacheState(state: CacheState, key?: string): void {
    if (!this.cls.isActive()) return;
    this.cls.set('cache', state);
    if (key) this.cls.set('cacheKey', key);
  }

  /**
   * 读当前请求的 requestId；无上下文时返回 undefined。
   *
   * requestId 不再单独存进 store 的字符串 key：它由 ClsMiddleware 的
   * `generateId` + `idGenerator` 生成并存入 CLS_ID，统一用 `cls.getId()` 读取（ADR-005）。
   */
  getRequestId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined;
  }

  /** 读当前请求的业务码；无上下文时返回 undefined。 */
  getBizCode(): string | undefined {
    return this.cls.get('bizCode');
  }

  /** 写入当前请求的业务码（由 GlobalExceptionsFilter 调用）；无上下文时静默忽略。 */
  setBizCode(bizCode: string): void {
    if (!this.cls.isActive()) return;
    this.cls.set('bizCode', bizCode);
  }
}
