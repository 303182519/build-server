# MEMORY.md

本仓库跨会话长期事实（仅记录稳定、可复用信息；日常变更见 `YYYY-MM-DD.md`）。

## 执行环境限制

- 本工作区 `execute_command` 不可用，固定报 `spawn C:\Program Files\Git\bin\bash.exe ENOENT`，**无法运行** `tsc` / `eslint` / `prettier` / `build` / 测试。
- 因此校验只能依赖 IDE 的 `read_lints`（对改动文件确认 0 diagnostics），并在回复中**如实声明未运行命令**，不得宣称校验通过（AGENTS.md §21）。

## 日志体系（Pino）关键约定

- 配置入口：`src/config/config.default.ts` → `getLoggerConfig()`；`src/shared/logger/logger.module.ts` 组装。
- **级别口径统一按 HTTP 状态码**：5xx / 未预期异常 = `error`，4xx = `warn`。访问日志（`customLogLevel`）与全局异常过滤器（`GlobalExceptionsFilter`）必须保持一致，否则同一请求级别自相矛盾。
- `error.log` 是 pino-roll 的独立 target，**只收 error 级别**（`level` 必须写在 target 层，写进 `options` 会被忽略）。因此任何「预期内的客户端问题」若按 error 记录，都会污染 error.log 与 error 告警。
- 只保留响应结束的一条访问日志，**不产出「请求到达」日志**（`customLogLevel` 只在响应结束时被调用）。若将来重新引入到达日志，必须重新区分到达/结束两个时点。
- 慢请求只追加 `[SLOW]` 标记、**不改变级别**；告警应在采集侧按 `[SLOW]` / `responseTime` 配置。
- **流式响应（SSE）不参与慢请求判定（2026-09-11）**：`responseTime` 对 SSE 是连接生命周期时长而非处理耗时，
  按 `Content-Type: text/event-stream` 识别（`logger.module.ts` 的 `isEventStreamResponse()`）后跳过 `[SLOW]`，
  **不硬编码路径**（新增 SSE 端点自动生效）；`responseTime` 字段仍保留，只抑制标记。
  新增 SSE 端点**必须**设置该响应头，否则退化为「每次连接断开都被标 `[SLOW]`」（见 ADR-002 决策第 12 条）。
- 敏感信息双重脱敏：`pinoHttp.redact`（请求头凭证、password/token 等字段）+ `sanitizeUrl()`（`src/shared/logger/log-sanitizer.ts`，覆盖 query 中的 token/code/ticket 等）。手写日志若直接打印 `request.url` 会绕过脱敏。

### nestjs-pino Logger 桥接行为（易错，务必按此写法）

`main.ts` 用 `app.useLogger(app.get(PinoLogger))` 桥接 NestJS `Logger`，转发链路有两处反直觉：

1. **最后一个可变参数恒被当作 `context`**（`nestjs-pino/dist/Logger.js` 的 `call()`）。
2. 结构化日志必须**对象在前、消息字符串在后**：`this.logger.error({ ...fields }, 'msg')`。
   - 若写成 `this.logger.error('msg', { fields })`，对象会被当成 `context` 或插值参数，**不会**成为顶层字段。
3. `this.logger.error(msg, stackString)` 若 stack 匹配 `/\n\s*at /`，bridge 会构造 `new Error(msg)` 并把 `stack` 覆盖为传入值 → 日志里 `err.type` 变成 `"Error"`、`err.message` 是被格式化后的 message（与 stack 首行不一致）。想要真实异常名请用 `{ err: exception }` 字段（前提：`serializers` 里已注册 `err`）。

### pino-http 序列化行为与字段契约（易错）

- `customAttributeKeys:{req:'request',res:'response',err:'error'}` 会让 pino-http 把序列化器写到
  `serializers.request / .response / .error`，**不写 `err`**。pino 默认不序列化 `Error`，因此业务日志
  `{ err: exception }` 必须配合 `serializers.err = stdSerializers.err`，否则落成 `{}`、message/stack 全丢。
- `pino-std-serializers` 的 `wrapRequestSerializer` / `wrapResponseSerializer` 会**先跑内置序列化器**，再把
  规范化结果交给自定义序列化器（实现为 `custom(reqSerializer(req))`）。传入对象**确实含自有可枚举的
  `headers`**（还有 id/query/params/remoteAddress/remotePort），所以「只保证 method/url、headers 不存在」的说法
  **是错的**（2026-09-11 更正，旧表述来自代码注释的误传）。应用日志**禁止把 `request` / `response` 当键名**
  （普通对象会被内置 res 序列化器按 `headersSent ? statusCode : null` 改写成 `null`）。
- **脱敏路径必须用重命名后的键名**（易错，2026-09-11 核实）：pino-http 把请求/响应绑定在
  `customAttributeKeys.req/res` 指定的键上（项目为 `request` / `response`），序列化器也注册在该键；
  pino 的 `asChindings`/`_asJson` 是「先跑 serializer，再按**顶层键名**取脱敏 stringifier」，
  因此 `req.headers.authorization` / `res.headers[...]` 这类路径**恒不生效**，必须写
  `request.headers.authorization` / `response.headers["set-cookie"]`。当前之所以不泄露，仅因 req 序列化器
  只输出 `{ method, url }`、未含 headers —— 一旦往里加 headers，凭证会明文落盘（`README.md` 相关说法需同步）。
- 顶层 `requestId` 的来源是 **pino-http 的请求级 child 绑定**（`pinoHttp.quietReqLogger: true` +
  `customAttributeKeys.reqId: 'requestId'`），**既不是** mixin、**也不是** req 序列化器
  （2026-09-11 修订：此前仅靠 mixin 读 CLS，长连接会丢 id，详见下一条）。
- **requestId 的三条硬约定（2026-09-11 修复「长连接丢失 requestId」后确立，勿回退）**：
  1. id 的唯一真相源是 `src/common/request-id.ts` 的 `resolveRequestId()`（`req.id` → `X-Request-ID`
     → 新 UUID），`RequestIdMiddleware` 与 pino-http 的 `genReqId` **必须共用**：各自 `randomUUID()`
     会产出**两个不同**的 id（访问日志 vs 响应头 / 响应体对不上）。
  2. 顶层 `requestId` 由 `quietReqLogger: true` + `customAttributeKeys.reqId: 'requestId'` 的请求级
     绑定承载（pino-http **仅在 `quietReqLogger: true`** 时创建该 child；默认 false 时 `req.id` 只藏在
     `request` 序列化对象里）。**不得关闭这两个开关**：关掉后退回「仅 mixin 注入」，长连接 / 手动
     `@Res()` 的访问日志会丢 `requestId`。
  3. `mixin` 现只负责 `bizCode`（只能走 CLS）+ `requestId` 同值兜底。CLS 边界依然存在：长连接 /
     手动 `@Res()` 响应的 `res.end()` 由 socket `close` 回调或 Redis Pub/Sub 回调触发（root 上下文），
     此时 `bizCode` 与兜底 `requestId` 取不到（访问日志的**权威** `requestId` 已不受影响）。
- `quietReqLogger: true` 的副作用（预期内）：应用日志（`req.log` / nestjs-pino `PinoLogger`）
  **不再携带 `request` 序列化对象**，HTTP 维度只出现在访问日志；`quietResLogger` 保持默认 false，
  访问日志仍有 `request` / `response` / `responseTime`。
- **字段契约（单一真相源）**：HTTP 维度（`request.method` / `request.url` / `response.statusCode` /
  `responseTime`）只由访问日志承载；`requestId` / `bizCode` 只在**顶层**
  （`requestId` ← pino-http 请求级绑定；`bizCode` ← mixin 读 CLS）；
  `err` 只在 5xx 错误日志。**4xx 不再单独记日志**（曾同一 401 双写两条 warn + 字段路径不一致），
  业务码由访问日志顶层 `bizCode` 暴露。

## 项目约定

- 异常响应统一由 `GlobalExceptionsFilter`（`@Catch()`，注册在 `common.module.ts` 的 `APP_FILTER`）产出 `StandardResponse`：`code`(HTTP) / `bizCode`(MMSNN 业务码) / `message` / `data` / `path` / `requestId`。
- 业务错误码按模块分文件（如 `src/common/exceptions/auth.exception.ts` 的 `AuthExceptionCode`），4xx 段与 5xx 段与 HTTP 状态类别保持一致。
- 架构决策记录：`docs/architecture/decisions/`（日志相关见 `ADR-002-logging-pipeline.md`）。
