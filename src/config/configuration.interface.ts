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

export interface StorageConfig {
  /** 存储后端类型：local = 本地磁盘，s3 = S3 兼容对象存储 */
  backend: 'local' | 's3';
  /** local 模式：文件写入根目录（相对 cwd 或绝对路径） */
  localDir: string;
  /** local 模式：对外 URL 前缀，需和 main.ts 挂载的 static prefix 一致 */
  publicPrefix: string;
}

export interface UploadConfig {
  /** 单文件硬上限（字节），超过则 multer 在缓冲阶段中断 */
  maxBytes: number;
  /** 封面归一化最大宽度（像素） */
  coverMaxWidth: number;
  /** 封面归一化目标格式 */
  coverFormat: 'webp' | 'jpeg' | 'png';
}

export interface S3Config {
  /** S3 区域 */
  region: string;
  /** S3 端点（AWS 留空，R2/MinIO 填写） */
  endpoint?: string;
  /** 是否使用 path-style 寻址（MinIO = true，AWS/R2 = false） */
  forcePathStyle: boolean;
  /** Bucket 名称 */
  bucket: string;
  /** 访问密钥 ID */
  accessKeyId?: string;
  /** 访问密钥 Secret */
  secretAccessKey?: string;
  /** 公开访问前缀（CDN / 自定义域），不填则按 endpoint+bucket 拼接 */
  publicBaseUrl?: string;
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

export interface LoggerConfig {
  /** 日志级别：trace < debug < info < warn < error < fatal */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** 是否启用结构化 JSON 日志（生产环境推荐 true） */
  jsonFormat: boolean;
  /** 是否包含请求上下文信息（requestId, userId 等） */
  includeContext: boolean;
  /** 慢请求阈值（毫秒），超过此值的请求标记为 warn */
  slowRequestThreshold: number;
  /** 日志输出目标：console = 控制台，file = 文件，both = 两者 */
  output?: 'console' | 'file' | 'both';
  /** 日志文件目录（仅在 file 或 both 模式下生效） */
  logDir?: string;
  /** 单个日志文件最大大小（MB），超过后自动轮转 */
  maxFileSize?: number;
  /** 保留的轮转文件数量（0 = 不限制） */
  maxFiles?: number;
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
  storage?: StorageConfig;
  upload?: UploadConfig;
  s3?: S3Config;
  logger?: LoggerConfig;
}

export type AppConfigForced = {
  [K in keyof AppConfig]-?: Required<NonNullable<AppConfig[K]>>;
};
