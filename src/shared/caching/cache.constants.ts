import { createHash } from 'crypto';

/**
 * 缓存 Key 命名空间集中维护，避免散落字符串拼接。
 * 最终落地 Key = `${REDIS_KEY_PREFIX}${业务命名空间}:...`
 */
export const hashCacheToken = (token: string): string => {
  return createHash('sha256').update(token).digest('hex');
};

/**
 * CacheKeys — 跨模块共享的缓存 Key 工厂。
 *
 * 适用边界：
 *   ✅ 跨模块会被多处引用的 key（auth / rbac / 全局配置等）
 *   ✅ 参数少（≤3）、redis-cli 可读性重要的场景
 *
 * 不适用：
 *   ❌ 仅模块内部使用的 key — 放在模块本地 factory 里（如 PostsService.listKey）
 *   ❌ 参数多（≥4）的查询 key — 用 JSON 序列化更简洁，字段不容易漏
 *   ❌ 直连 Redis 但不走 CacheService 的 key（如 throttler）— 走 KeyPrefixer.prefix() 手动加 namespace
 *
 * 最终落盘 Key = `${KeyPrefixer.namespace}:${这里的返回值}`（CacheService 走 KeyvRedis 会自动加）。
 */
export const CacheKeys = {
  // 单值ID场景，短形式可接受，但建议统一
  USER_BY_ID: (id: string | number) => `user:profile:id=${id}`,
  BENCHMARK_USER_BY_ID: (id: string | number) =>
    `benchmark:user:profile:id=${id}`,

  // 多维度查询，必须显式参数名
  USER_BY_USERNAME: (username: string) => `user:profile:username=${username}`,
  ROLE_TREE: (roleId: string | number) => `rbac:roleTree:roleId=${roleId}`,
  PERMISSION_BY_USER: (userId: string | number) =>
    `auth:permission:userId=${userId}`,

  // token本身是敏感值，hash后当key是对的，但命名可以更清晰
  AUTH_REFRESH_TOKEN: (token: string) =>
    `auth:refreshToken:hash=${hashCacheToken(token)}`,

  // 登录失败计数器：邮箱归一化（trim + 小写），避免大小写差异算成两个账号
  AUTH_LOGIN_FAIL: (email: string) =>
    `auth:loginFail:email=${email.trim().toLowerCase()}`,

  // OAuth 一次性令牌：state 防 CSRF（TTL 10min），ticket 换 token（TTL 60s）
  AUTH_OAUTH_STATE: (state: string) => `auth:oauthState:state=${state}`,
  AUTH_OAUTH_TICKET: (ticket: string) => `auth:oauthTicket:ticket=${ticket}`,

  // 热门文章排行榜 ZSET：member=post id，score=浏览数。全局唯一，无参数。
  TRENDING_POSTS: 'hot:posts',

} as const;
