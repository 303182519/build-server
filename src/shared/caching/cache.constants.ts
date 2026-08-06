import { createHash } from 'crypto';

/**
 * 缓存 Key 命名空间集中维护，避免散落字符串拼接。
 * 最终落地 Key = `${REDIS_KEY_PREFIX}${业务命名空间}:...`
 */
export const hashCacheToken = (token: string): string => {
  return createHash('sha256').update(token).digest('hex');
};

/**
 * 业务:参数1=值1:参数2=值2（如 order:list:supplier=A:page=1）
 */
export const CacheKeys = {
  USER_BY_ID: (id: string | number) => `users:${id}`,
  BENCHMARK_USER_BY_ID: (id: string | number) => `benchmark:users:${id}`,

  USER_BY_USERNAME: (username: string) => `users:username:${username}`,
  ROLE_TREE: (roleId: string | number) => `roles:tree:${roleId}`,
  PERMISSION_BY_USER: (userId: string | number) => `permissions:user:${userId}`,


  AUTH_REFRESH_TOKEN: (token: string) =>
    `auth:refresh:${hashCacheToken(token)}`,
} as const;

/**
 * 改造后 - 更规范的企业级命名
export const CacheKeys = {
  // 单值ID场景，短形式可接受，但建议统一
  USER_BY_ID: (id: string | number) => `user:profile:id=${id}`,
  BENCHMARK_USER_BY_ID: (id: string | number) => `benchmark:user:profile:id=${id}`,
  
  // 多维度查询，必须显式参数名
  USER_BY_USERNAME: (username: string) => `user:profile:username=${username}`,
  ROLE_TREE: (roleId: string | number) => `rbac:roleTree:roleId=${roleId}`,
  PERMISSION_BY_USER: (userId: string | number) => `auth:permission:userId=${userId}`,
  
  // token本身是敏感值，hash后当key是对的，但命名可以更清晰
  AUTH_REFRESH_TOKEN: (token: string) => `auth:refreshToken:hash=${hashCacheToken(token)}`,
  
  // ===== 列表类场景（多参数） =====
  ORDER_LIST: (params: { supplierId: string; page: number; status?: string }) => 
    [
      'order:list',
      `supplierId=${params.supplierId}`,
      `page=${params.page}`,
      params.status !== undefined ? `status=${params.status}` : '',
    ].filter(Boolean).join(':'),
} as const; */
