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
| `LOG_OUTPUT` | `console` | `console` \| `file` |
| `LOG_DIR` | `logs` | 日志目录（文件输出时自动创建） |
| `LOG_MAX_FILE_SIZE` | `10` | 单个日志文件上限（MB） |
| `LOG_MAX_FILES` | `7` | 轮转文件保留数量（`0` = 不限制） |

### 控制台格式

| 环境 | 控制台输出 |
| --- | --- |
| 开发（`NODE_ENV=development` 或未设置）且 `LOG_JSON_FORMAT=false` 或未设置 | `pino-pretty` 人类可读格式（带颜色） |
| 其他所有情况（生产 / test / staging / 显式 `LOG_JSON_FORMAT=true`） | 单行 JSON（写入 stdout，可被采集链路直接解析） |

> ⚠️ `pino-pretty` 被放在 **devDependencies**（生产镜像 `pnpm install --prod` 不会安装它），
> 因此代码用 `IsDev` 而不是「非生产」来收敛：只有真正的开发环境才会加载该 transport。
> 非开发环境即使把 `LOG_JSON_FORMAT` 设成 `false`，控制台也只会输出 JSON——这既保证采集链路
> 永远拿到结构化日志，也避免缺包时 transport 初始化失败导致应用启动即崩。

### 文件输出

`LOG_OUTPUT` 为 `file` 时按大小轮转，`error` 级别单独落盘：

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

1. 确认 `LOG_OUTPUT` 为 `file`。
2. 确认 `LOG_DIR` 有写权限（模块会自动 `mkdir`）。
3. **确认 `transport` 写在 `pinoHttp` 内部**——写在外层会被 nestjs-pino 忽略。

### `error.log` 里出现了 info 日志

`level` 必须写在 transport target 层：

```ts
{ target: 'pino-roll', level: 'error', options: { /* ... */ } }
```

### 生产 stdout 不是 JSON

检查 `NODE_ENV` 是否真的是 `production`（生产默认 `LOG_JSON_FORMAT=true`，控制台即 JSON）。
若 `NODE_ENV` 不是 `production`，控制台会走 `pino/file` 输出 JSON 而不是 `pino-pretty`，
两者都是 JSON，但注意 `pino-pretty` 仅在开发环境下启用。

### 启动报错 `option.transport.targets do not allow custom level formatters`

这是 pino `normalizeArgs` 的硬性约束：只要用了 `transport.targets` 数组多路输出，
就**不允许**再传 `formatters.level` 函数（pino 无法把该函数传给 worker 线程）。

本模块为了同时输出「console + 全量文件 + 仅 error 文件」必须使用 targets，
因此 `level` 保持 pino 默认的**数字级别**（`10/20/30/40/50/60`）：

- 开发控制台：`pino-pretty` 仍会渲染成 `INFO` / `ERROR` 等标签，肉眼体验不变。
- JSON（生产 stdout / `app.log`）：`"level":30` 这种数字是 pino 标准格式，
  采集链路按数字级别解析即可，不要依赖大写字符串。
- `error.log` 的级别过滤依赖 target 层的 `level: 'error'`（字符串），与输出字段无关。

### Windows 控制台中文乱码（形如 `宸茶繛鎺`）

**这是终端代码页问题，不是日志内容问题**，应用侧无需（也不应）改动。

根因链条：

1. 日志由 transport **worker 线程**产出：worker 用 `StringDecoder('utf8')` 还原出正确的
   JS 字符串，再交给目标流（`pino-pretty` / `pino/file`，底层均为 sonic-boom）。
2. sonic-boom 把字符串按 **UTF-8 字节**直接写到 fd 1，绕过 Windows 的 `WriteConsoleW`。
3. Windows 控制台默认代码页是 936（GBK），于是把 UTF-8 字节按 GBK 解码，得到
   `已连接` → `宸茶繛鎺?`（尾部落单字节被显示为 `?`）。

这也解释了为什么 `console.log('中文')` 正常、只有日志乱码：主线程写 stdout 走
`uv_tty` → `WriteConsoleW`（UTF-16），与代码页无关；worker 线程是裸字节写 fd。

解决（任选其一，推荐第 1 条）：

```powershell
# 1. 启动前把当前控制台切到 UTF-8（PowerShell / cmd 均可，只需执行一次）
chcp 65001
pnpm start:dev

# 2. 系统级：设置 → 时间和语言 → 语言和区域 → 管理语言设置 →
#    更改系统区域设置 → 勾选「Beta: 使用 Unicode UTF-8 提供全球语言支持」（需重启）
```

> ⚠️ 不要试图把日志输出改成 GBK 来迁就控制台：pino 没有编码开关，且生产是 Linux
> 容器（UTF-8），改编码只会把生产日志一起弄坏。
> 文件输出（`app.log` / `error.log`）始终是 UTF-8，用编辑器打开中文正常，
> 说明落盘数据本身没有问题。

### 请求被客户端中断后没有访问日志

`pino-http` 会在 `finish` **和** `close` 时产出日志；被中断的请求
（`res.writableEnded === false`）会被 `customLogLevel` 提升到 `warn` 级别，便于排查。

## 相关资源

- [Pino 官方文档](https://getpino.io/)
- [nestjs-pino GitHub](https://github.com/iamolegga/nestjs-pino)
- [pino-roll](https://github.com/mcollina/pino-roll)
