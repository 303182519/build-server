export interface ServerConfig {
  port?: number;
  apiPrefix?: string;
  timeout?: number;
}

export interface SwaggerConfig {
  enabled?: boolean;
  path?: string;
  title?: string;
  description?: string;
  version?: string;
}

export interface JwtConfig {
  secret?: string;
  accessExpiresIn?: number;
  refreshExpiresIn?: number;
}

export interface DatabaseConfig {
  url: string;
}

export interface SnowflakeConfig {
  workerId: number;
  datacenterId: number;
}

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  defaultTtl?: number;
  keyPrefix?: string;
}

export interface ThrottlerConfig {
  /** 默认时间窗口（毫秒） */
  ttl: number;
  /** 窗口内最大请求数 */
  limit: number;
}

export interface GithubConfig {
  /** GitHub OAuth App Client ID，为空则禁用 GitHub 登录 */
  clientId?: string;
  /** GitHub OAuth App Client Secret */
  clientSecret?: string;
  /** 授权回调地址（GitHub → 本服务后端） */
  callbackUrl?: string;
  /** 登录完成后 302 跳到的前端回调页地址（本服务后端 → 前端 SPA） */
  frontendRedirectUrl?: string;
}

export interface BoardConfig {
  /** 是否启用 Bull Board 任务监控面板 */
  enabled: boolean;
  /** 面板挂载路径（Express 中间件路径，不含 /api 前缀） */
  path: string;
  /** 认证类型：jwt = 校验 JWT 令牌 + 特殊角色；none = 无认证（仅限开发/内网） */
  authType: 'jwt' | 'none';
  /** 只读模式：仅允许查看，禁止重试/清理/删除等操作 */
  readOnly: boolean;
}

export interface AppConfig {
  server?: ServerConfig;
  swagger?: SwaggerConfig;
  database?: DatabaseConfig;
  jwt?: JwtConfig;
  snowflake?: SnowflakeConfig;
  redis?: RedisConfig;
  throttler?: ThrottlerConfig;
  github?: GithubConfig;
  board?: BoardConfig;
}

export type AppConfigForced = {
  [K in keyof AppConfig]-?: Required<NonNullable<AppConfig[K]>>;
};
