# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
pnpm run start:dev      # 开发模式（先 prisma generate，再 nest --watch）
pnpm run start:prod     # 生产启动 node dist/main
pnpm run build          # 构建（prisma generate + nest build）
pnpm run lint           # ESLint --fix
pnpm run format         # Prettier
pnpm run test           # Jest 单元测试
pnpm run test:e2e       # E2E 测试
pnpm run db:generate    # prisma generate（生成 Prisma Client）
pnpm run db:dev         # prisma migrate dev
pnpm run db:deploy      # prisma migrate deploy（生产迁移）
```

## Architecture

**技术栈**: NestJS 11 + Prisma 5 (MariaDB/MySQL) + Joi 验证 + Swagger

### 配置系统

- `ConfigModule` 是全局模块（`isGlobal: true`），在任何地方注入 `ConfigService` 即可
- 配置加载流程：`config.default.ts` → 合并 `env/config.{NODE_ENV}.ts`，用 `es-toolkit.merge` 做 deep merge
- `getConfig(configService)` 返回合并后的 `AppConfigForced`（所有字段变为必选）
- 环境变量通过 `env.validation.ts` 的 Joi schema 校验
- 路径别名 `@/*` → `./src/*`（tsconfig paths）

### 请求/响应管道

全局管道/过滤器/拦截器的注册顺序定义在 `src/common/use/index.ts` 的 `appUse()`：

1. **GlobalExceptionsFilter** — 最外层异常捕获，将所有异常转为 `StandardResponse { code, data, message, timestamp }`
2. **ResponseInterceptor** — 包装成功响应为标准格式；已含标准字段则透传，避免重复包装
3. **LoggingInterceptor** — 记录请求方法/URL/耗时
4. **ClassSerializerInterceptor** — 序列化/反序列化支持
5. **TimeoutInterceptor** — 超时控制（从配置读取）
6. **ValidationPipe** — 全局校验管道，`transform: true` + `whitelist: true`，校验失败返回中文错误

### 异常体系

- `BaseException extends HttpException` — 基础异常，携带 `{ message, code, statusCode }`
- `ErrorException` — 业务异常，通过 `ErrorExceptionCode` 枚举查 `ErrorExceptionMap` 获取对应的 message/status
- 错误码命名规则：`MMSNN`（模块码 + 状态码类别 + 序列号），如 `10401` = Auth(10) + 4xx(4) + 01

### Database (Prisma)

- `PrismaService extends PrismaClient`，直接连接 MariaDB（无需 driver adapter）
- 数据库连接从 `getConfig(configService).database.url` 读取（即 `DATABASE_URL` 环境变量）
- Prisma schema 位于 `prisma/schema.prisma`，client 输出到 `src/generated/prisma/`
- `PrismaModule` 是 `@Global()` 模块，通过 token `'PrismaClient'` 注入

### 项目状态

Auth 模块（`src/modules/auth/`）和 Users 模块大部分代码处于注释状态，功能尚未启用。当前 `AppModule` 只导入了 `AppConfigModule`，`modules/index.ts` 中模块导入也被注释。

### 目录约定

| 目录 | 用途 |
|---|---|
| `src/common/` | 通用基础设施（filters, interceptors, pipes, exceptions, response, validators） |
| `src/config/` | 配置系统（模块、接口、默认值、环境配置、Joi 校验） |
| `src/modules/` | 业务模块 |
| `src/shared/` | 共享服务（Prisma、工具函数） |
| `src/generated/prisma/` | Prisma Client 自动生成，不手动编辑 |
| `prisma/` | Prisma schema 和迁移文件 |
