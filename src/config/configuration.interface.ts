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
  /** 授权回调地址 */
  callbackUrl?: string;
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
}

export type AppConfigForced = {
  [K in keyof AppConfig]-?: Required<NonNullable<AppConfig[K]>>;
};
