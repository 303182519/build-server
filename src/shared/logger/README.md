# Pino 日志模块使用指南

## 概述

本模块基于 `nestjs-pino` + `pino` 提供结构化日志能力，覆盖三件事：

1. **HTTP 访问日志**：由 `pino-http` 统一产出（不再有自建中间件/拦截器）。
2. **应用日志**：`main.ts` 通过 `app.useLogger(app.get(Logger))` 把 NestJS 全局 `Logger`
   桥接到 pino，因此业务代码里的 `new Logger(XxxService.name)` 同样会产出结构化日志。
3. **文件落盘与轮转**：由 `pino-roll` 完成。

> ⚠️ 关键约束（踩坑点）：`nestjs-pino` 的 `forRoot/forRootAsync` 只消费
> `Params` 上的 `pinoHttp / exclude / forRoutes / useExisting / assignResponse` 五个键。
> pino 自身的 `level / transport / formatters / redact / mixin` 必须写在 **`pinoHttp` 内部**，
> 放在 `Params` 根层级会被静默忽略（旧实现的文件输出就是因为这个原因从未生效）。

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | trace < debug < info < warn < error < fatal < silent |
| `LOG_JSON_FORMAT` | 生产 `true` / 其他 `false` | 控制台是否输出结构化 JSON |
| `LOG_INCLUDE_CONTEXT` | `true` | 是否通过 CLS 给所有日志附带 `requestId` |
| `LOG_SLOW_REQUEST_THRESHOLD` | `1000` | 慢请求阈值（毫秒），超阈值追加 `[SLOW]` |
| `LOG_OUTPUT` | `both` | `console` \| `file` \| `both` |
| `LOG_DIR` | `logs` | 日志目录（文件输出时自动创建） |
| `LOG_MAX_FILE_SIZE` | `10` | 单个日志文件上限（MB） |
| `LOG_MAX_FILES` | `7` | 轮转文件保留数量（`0` = 不限制） |

### 控制台格式

| 环境 | 控制台输出 |
| --- | --- |
| 生产（或 `LOG_JSON_FORMAT=true`） | 单行 JSON（写入 stdout，可被采集链路直接解析） |
| 开发（`LOG_JSON_FORMAT=false`） | `pino-pretty` 人类可读格式（带颜色） |

### 文件输出

`LOG_OUTPUT` 为 `file` 或 `both` 时按大小轮转，`error` 级别单独落盘：

```
logs/
├── app.log        # 全级别
├── app.<n>.log    # 历史轮转文件（命名由 pino-roll 决定）
├── error.log      # 仅 error 及以上
└── error.<n>.log
```

- `error` 过滤依赖 **target 层的 `level: 'error'`**；若把 `level` 写进 `options` 会被忽略，
  导致 `error.log` 收下所有级别。
- 本项目**不做应用内 gzip 压缩**。日志压缩/归档建议交给 logrotate、日志采集 Agent
  或容器平台的日志驱动处理（应用内压缩会持续占用 CPU 与磁盘 IO）。

## 使用方法

### 推荐：直接使用 NestJS Logger（已桥接）

```typescript
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  async createUser(dto: CreateUserDto) {
    this.logger.log('创建用户'); // → pino info
    this.logger.debug('开始写入', { username: dto.username });
    try {
      return await this.repo.create(dto);
    } catch (error) {
      // 第二个参数会作为结构化字段合并进日志
      this.logger.error('创建用户失败', { username: dto.username });
      throw error;
    }
  }
}
```

### 可选：注入 PinoLogger（需要更细的控制）

```typescript
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class UserService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(UserService.name);
  }

  async createUser(dto: CreateUserDto) {
    this.logger.info({ username: dto.username }, '创建用户');
  }
}
```

### 请求上下文（requestId）

- 入站请求：`RequestIdMiddleware` 会复用 `X-Request-ID` 请求头，缺失时生成 UUID，
  并写回同名响应头。
- HTTP 访问日志：从序列化后的 `request.requestId` 读取。
- 应用日志：当 `LOG_INCLUDE_CONTEXT=true` 时，通过 pino `mixin` 读取 CLS，
  给**拿不到 `req` 的深层代码**（service / 异步回调）也补上顶层 `requestId`。

> 注意：模块不自动注入 `userId` / `traceId`。需要这类字段请由业务代码显式传入。

## 安全：日志脱敏

1. **请求头凭证**：`pinoHttp.redact` 已内置 `authorization`、`cookie`、`set-cookie`，
   以及 `password / secret / token / accessToken / refreshToken / apiKey` 等常见字段，统一替换为 `[REDACTED]`。
2. **URL 查询参数**：`sanitizeUrl()`（`log-sanitizer.ts`）会在写日志前脱敏
   `token / code / ticket / signature / apiKey ...` 等敏感 query 参数，
   覆盖 OAuth 回调 ticket 之类的场景。

```typescript
import { sanitizeUrl } from '@/shared/logger/log-sanitizer';

this.logger.debug(`callback ${sanitizeUrl(req.url)}`);
```

> ⚠️ 记录请求体（body）时请自行确认不含密码/凭证，`redact` 只能覆盖配置过的字段路径。

## 健康探针

`/api/health`、`/api/health/ready`（含无前缀形式）通过 `autoLogging.ignore` 过滤掉访问日志，
避免探针高频调用污染日志。注意：该过滤只关闭"自动访问日志"，不影响应用日志与上下文。

## 故障排查

### 日志没有输出到文件

1. 确认 `LOG_OUTPUT` 为 `file` 或 `both`。
2. 确认 `LOG_DIR` 有写权限（模块会自动 `mkdir`）。
3. **确认 `transport` 写在 `pinoHttp` 内部**——写在外层会被 nestjs-pino 忽略。

### `error.log` 里出现了 info 日志

`level` 必须写在 transport target 层：

```ts
{ target: 'pino-roll', level: 'error', options: { /* ... */ } }
```

### 生产 stdout 不是 JSON

检查 `LOG_JSON_FORMAT` 是否被显式设成了 `false`（生产默认 `true`）。
`LOG_JSON_FORMAT=false` 时控制台走 `pino-pretty`，输出的是人类可读文本而非 JSON。

### 请求被客户端中断后没有访问日志

`pino-http` 会在 `finish` **和** `close` 时产出日志；被中断的请求
（`res.writableEnded === false`）会被 `customLogLevel` 提升到 `warn` 级别，便于排查。

## 相关资源

- [Pino 官方文档](https://getpino.io/)
- [nestjs-pino GitHub](https://github.com/iamolegga/nestjs-pino)
- [pino-roll](https://github.com/mcollina/pino-roll)
