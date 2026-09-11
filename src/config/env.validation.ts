import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Database
  DATABASE_URL: Joi.string(),

  // Initial Admin User
  DEFAULT_ADMIN_USERNAME: Joi.string().required(),
  DEFAULT_ADMIN_PASSWORD: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRES_IN: Joi.number().default(900),
  JWT_REFRESH_EXPIRES_IN: Joi.number().default(604800),

  // Server
  PORT: Joi.number().port(),

  // Swagger
  SWAGGER_OPEN: Joi.boolean().default(true),

  // Snowflake ID Generator
  WORKER_ID: Joi.number().integer().min(0).max(31).default(0),
  DATACENTER_ID: Joi.number().integer().min(0).max(31).default(0),

  // Redis (可选；未配置时缓存模块降级为内存 store)
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }),
  REDIS_HOST: Joi.string(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow(''),
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),
  REDIS_DEFAULT_TTL: Joi.number().integer().min(0).default(300),
  REDIS_KEY_PREFIX: Joi.string().default('my-first-nest'),

  // Throttler (限流)
  THROTTLER_TTL: Joi.number().integer().min(1000).default(60000),
  THROTTLER_LIMIT: Joi.number().integer().min(1).default(60),

  // OAuth
  GITHUB_CLIENT_ID: Joi.string(),
  GITHUB_CLIENT_SECRET: Joi.string(),
  GITHUB_CALLBACK_URL: Joi.string(),
  FRONTEND_REDIRECT_URL: Joi.string(),

  // Node Environment
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  // Bull Board（任务监控面板）
  BULL_BOARD_ENABLED: Joi.string().valid('true', 'false'),
  BULL_BOARD_PATH: Joi.string(),
  BULL_BOARD_AUTH_TYPE: Joi.string().valid('jwt', 'none'),
  BULL_BOARD_READ_ONLY: Joi.string().valid('true', 'false'),

  // 文件存储
  STORAGE_BACKEND: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_DIR: Joi.string().default('uploads'),
  STORAGE_PUBLIC_PREFIX: Joi.string().default('/uploads'),

  // 文件上传
  UPLOAD_MAX_BYTES: Joi.number().integer().min(1).default(5242880),
  UPLOAD_COVER_MAX_WIDTH: Joi.number().integer().min(1).default(1600),
  UPLOAD_COVER_FORMAT: Joi.string()
    .valid('webp', 'jpeg', 'png')
    .default('webp'),

  // S3 兼容对象存储
  S3_REGION: Joi.string().default('auto'),
  S3_ENDPOINT: Joi.string().allow(''),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('false'),
  S3_BUCKET: Joi.string().allow(''),
  S3_ACCESS_KEY_ID: Joi.string().allow(''),
  S3_SECRET_ACCESS_KEY: Joi.string().allow(''),
  S3_PUBLIC_BASE_URL: Joi.string().allow(''),

  // Pino Logger (日志)
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
    .default('info'),
  LOG_JSON_FORMAT: Joi.string().valid('true', 'false'),
  LOG_INCLUDE_CONTEXT: Joi.string().valid('true', 'false'),
  LOG_SLOW_REQUEST_THRESHOLD: Joi.number().integer().min(100).default(1000),
  LOG_OUTPUT: Joi.string().valid('console', 'file', 'both').default('both'),
  LOG_DIR: Joi.string().default('logs'),
  LOG_MAX_FILE_SIZE: Joi.number().integer().min(1).default(10),
  LOG_MAX_FILES: Joi.number().integer().min(0).default(7),
  LOG_COMPRESS_OLD_FILES: Joi.string().valid('true', 'false'),
}).oxor('REDIS_URL', 'REDIS_HOST'); // Redis 连接二选一,也可都不提供
