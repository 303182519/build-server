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
| `LOG_OUTPUT` | `console` | `console` \| `file`（物理机 / 虚拟机裸机部署（非容器），才需要 file） |
| `LOG_INCLUDE_CONTEXT` | `true` | 是否通过 CLS 给所有日志附带 `requestId` / `bizCode` |
| `LOG_SLOW_REQUEST_THRESHOLD` | `500` | 慢请求阈值（毫秒），超阈值追加 `[SLOW]` |
| `LOG_DIR` | `logs` | 日志目录（文件输出时自动创建） |
| `LOG_MAX_FILE_SIZE` | `10` | 单个日志文件上限（MB） |
| `LOG_MAX_FILES` | `7` | 轮转文件保留数量（`0` = 不限制） |

### 控制台格式

控制台格式**只由 `NODE_ENV` 决定**（代码里的 `IsDev`），不存在独立开关；
下表仅在 `LOG_OUTPUT=console` 时生效（`LOG_OUTPUT=file` 时只落盘不写控制台）：

| `NODE_ENV` | 控制台输出 |
| --- | --- |
| `development` 或未设置 | `pino-pretty` 人类可读格式（带颜色） |
| `production` / `test` / `staging` 等其他值 | 单行 JSON（写入 stdout，可被采集链路直接解析） |

> ⚠️ `pino-pretty` 被放在 **devDependencies**（生产镜像 `pnpm install --prod` 不会安装它），
> 因此代码用 `IsDev` 而不是「非生产」来收敛：只有真正的开发环境才会加载该 transport。
> 非开发环境一律输出 JSON——这既保证采集链路永远拿到结构化日志，
> 也避免缺包时 transport 初始化失败导致应用启动即崩。

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

### 请求上下文（requestId / bizCode）

- 入站请求：`RequestIdMiddleware` 会复用 `X-Request-ID` 请求头，缺失时生成 UUID，
  并写回同名响应头，同时把 requestId 写进 CLS。
- 应用日志 + HTTP 访问日志：当 `LOG_INCLUDE_CONTEXT=true` 时，pino `mixin` 读取 CLS，
  给**拿不到 `req` 的深层代码**（service / 异步回调）也补上顶层 `requestId`。
- 业务码：`GlobalExceptionsFilter` 会把被拒绝请求的 `bizCode` 写进 CLS，同样由 `mixin`
  注入顶层 `bizCode`——这样「响应结束的那条访问日志」自带业务码。

> ⚠️ requestId / bizCode 只有**顶层**这一条字段路径，不要在日志里再输出
> `request.requestId` 之类的重复维度（见下文字段契约）。

> ⚠️ 关闭 `LOG_INCLUDE_CONTEXT` 会同时失去顶层 `requestId` 与顶层 `bizCode`。4xx 的业务码
> 只由访问日志承载，因此不希望丢 4xx 业务语义时请保持该开关为 `true`（默认）。

> 注意：模块不自动注入 `userId` / `traceId`。需要这类字段请由业务代码显式传入。

## 日志字段契约（单一真相源）

同一个维度只允许存在一条字段路径，否则采集侧要为告警/看板写两套字段规则。
当前契约：

| 维度 | 字段路径 | 归属日志 |
| --- | --- | --- |
| 请求 ID | 顶层 `requestId` | 访问日志 + 应用日志 |
| 业务码 | 顶层 `bizCode` | 访问日志（4xx / 5xx 都有）；5xx 错误日志另带一份 |
| HTTP 方法 / 路径 | `request.method` / `request.url` | **仅**访问日志 |
| HTTP 状态码 | `response.statusCode` | **仅**访问日志 |
| 耗时 | `responseTime` | **仅**访问日志 |
| 异常堆栈 | 顶层 `err`（`{ type, message, stack }`） | **仅** 5xx 错误日志 |
| 日志来源 | `context` | 应用日志（如 `GlobalExceptionsFilter`） |

由此推出两条行为约定：

1. **4xx 只产出一条日志**：异常过滤器不再单独记 4xx。此前同一请求会产出「过滤器 warn +
   访问日志 warn」两条重复记录，且字段路径不一致（`status` vs `response.statusCode`）。
   业务码改由访问日志的顶层 `bizCode` 暴露，告警规则按 `response.statusCode` + `bizCode` 配置即可。
2. **5xx 额外记一条 error 日志**：被异常过滤器捕获的异常不会流经 `pino-http`，堆栈只能在那里保留。
   该日志不重复 HTTP 维度，靠顶层 `requestId` 与访问日志关联。

> ⚠️ 异常过滤器用 `{ err: exception }` 记录异常：`pino` 默认**不**序列化 `Error`，模块已在
> `serializers` 注册 `err: stdSerializers.err`；不注册时 `err` 会落成 `{}`，message / stack 全丢。
>
> ⚠️ 不要把 `request` / `response` 当作**键名**写进应用日志：这两个键已被 pino-http 的序列化器
> 占用（`customAttributeKeys`），值会被 `pino-std-serializers` 的内置序列化器二次处理
> （例如 `{ statusCode: 401 }` 会被改写成 `{ statusCode: null }`，因为普通对象没有 `headersSent`）。

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

控制台格式只由 `NODE_ENV` 决定，没有独立的格式开关：

- `NODE_ENV=production`（或 `test` / `staging` 等非 `development` 值）→ 走 `pino/file` 写 stdout，输出单行 JSON。
- `NODE_ENV=development` 或未设置 → 走 `pino-pretty`，输出带颜色的人类可读格式（**不是** JSON）。

因此看到美化格式时，先确认 `NODE_ENV` 没有被设成 `development`（或漏设）。
另：`LOG_OUTPUT=file` 时日志只落盘、不写 stdout，也就不存在「stdout JSON」。

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

### 每个请求只产出一条访问日志（无「请求到达」日志）

模块**不**配置 `customReceivedMessage`，因此每个请求只有响应结束时的一条访问日志
（含 `statusCode` / `responseTime` / `[SLOW]`），不会出现 `... received` 那种到达行。
理由：到达行不含状态与耗时等结果信息，会让日志量翻倍、稀释检索并污染基于 `level` 的告警
；「请求开始/结束」的配对属于 APM / OpenTelemetry 的职责。
需要排障「请求到底有没有进来」时，可临时把 `LOG_LEVEL` 调到 `debug` 由应用日志兜底。

> ⚠️ 若重新启用到达日志：`pino-http` 的 `customLogLevel` 会同时被「请求到达」和「响应结束」
> 两个时点调用（无 `customReceivedLogLevel` 选项），必须显式区分两个时点，否则到达日志会被
> 判成 `warn`。

### 请求被客户端中断后的访问日志（级别 warn）

被客户端中断的请求**依然会**产出访问日志，不用担心它从日志里消失：`pino-http` 除了在
`finish`（响应正常写完）时产出，还会在 `close`（连接关闭）时产出，两者共用同一个处理函数
且只记一条。中断请求的特征是 `res.writableEnded === false`（服务端没来得及调用 `res.end()`），
会被 `customLogLevel` 提升到 `warn` 级别，便于排查。

> ⚠️ 因此 `warn` **不严格等于 4xx**：这类「客户端中断」的日志状态码可能是 2xx。
> 按 `level=warn` 配置告警时需要容忍这一类；排查时看到耗时偏小、不带 `[SLOW]`、
> 也不是 4xx 的 warn 行，应优先理解为客户端断开 / 超时，而非服务端故障。

## 相关资源

- [Pino 官方文档](https://getpino.io/)
- [nestjs-pino GitHub](https://github.com/iamolegga/nestjs-pino)
- [pino-roll](https://github.com/mcollina/pino-roll)
