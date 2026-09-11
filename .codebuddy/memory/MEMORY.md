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
- 敏感信息双重脱敏：`pinoHttp.redact`（请求头凭证、password/token 等字段）+ `sanitizeUrl()`（`src/shared/logger/log-sanitizer.ts`，覆盖 query 中的 token/code/ticket 等）。手写日志若直接打印 `request.url` 会绕过脱敏。

### nestjs-pino Logger 桥接行为（易错，务必按此写法）

`main.ts` 用 `app.useLogger(app.get(PinoLogger))` 桥接 NestJS `Logger`，转发链路有两处反直觉：

1. **最后一个可变参数恒被当作 `context`**（`nestjs-pino/dist/Logger.js` 的 `call()`）。
2. 结构化日志必须**对象在前、消息字符串在后**：`this.logger.error({ ...fields }, 'msg')`。
   - 若写成 `this.logger.error('msg', { fields })`，对象会被当成 `context` 或插值参数，**不会**成为顶层字段。
3. `this.logger.error(msg, stackString)` 若 stack 匹配 `/\n\s*at /`，bridge 会构造 `new Error(msg)` 并把 `stack` 覆盖为传入值 → 日志里 `err.type` 变成 `"Error"`、`err.message` 是被格式化后的 message（与 stack 首行不一致）。想要真实异常名请用 `{ err: exception }` 字段。

## 项目约定

- 异常响应统一由 `GlobalExceptionsFilter`（`@Catch()`，注册在 `common.module.ts` 的 `APP_FILTER`）产出 `StandardResponse`：`code`(HTTP) / `bizCode`(MMSNN 业务码) / `message` / `data` / `path` / `requestId`。
- 业务错误码按模块分文件（如 `src/common/exceptions/auth.exception.ts` 的 `AuthExceptionCode`），4xx 段与 5xx 段与 HTTP 状态类别保持一致。
- 架构决策记录：`docs/architecture/decisions/`（日志相关见 `ADR-002-logging-pipeline.md`）。
