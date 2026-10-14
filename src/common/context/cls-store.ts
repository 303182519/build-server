import type { User } from '@prisma/client';
import type { ClsStore } from 'nestjs-cls';

/**
 * 缓存命中状态：X-Cache 响应头的取值。
 *
 * 原先是 request-context.ts 的独立导出，随上下文基础设施迁移（ADR-005）收拢到此处。
 */
export type CacheState = 'HIT' | 'MISS' | 'BYPASS';

/**
 * 应用级 CLS store 形状（nestjs-cls 的强类型 store）。
 *
 * 迁移前这里有两份彼此独立的 AsyncLocalStorage：请求级 store（cache / cacheKey /
 * requestId / bizCode）与用户上下文（User）。迁移后统一为 nestjs-cls 的单一 store，
 * 两类状态共存于同一个请求上下文，故合并声明在此。
 */
export interface AppClsStore extends ClsStore {
  /**
   * 请求级 requestId。
   * 权威口径仍是 pino-http 的请求级绑定（见 ADR-002），此处仅作深层代码的兜底来源。
   */
  requestId?: string;
  /**
   * 请求级业务码。异常过滤器在拒绝 / 失败请求时写入，由 pino mixin 注入访问日志顶层。
   */
  bizCode?: string;
  /** 缓存命中状态。service 写入，CacheHeaderInterceptor 读出后写成 X-Cache 响应头。 */
  cache?: CacheState;
  /** 命中的缓存 key（当前仅记录，不对外输出）。 */
  cacheKey?: string;
  /** 当前请求的登录用户。由 UserContextInterceptor 在 JWT 守卫之后写入。 */
  user?: User;
}
