# ADR-002：日志链路统一到 pino 单一出口

**状态**
已采纳

**背景**

项目原本同时存在三套日志产出方式，彼此职责重叠、字段与级别口径不一致：

1. `nestjs-pino` 自动注册的 `pino-http` 访问日志（每条请求一条）；
2. 自建 `HttpLoggerMiddleware` 再次输出访问日志（第二条）；
3. 自建 `TimingInterceptor` 用 NestJS `Logger` 输出慢请求日志。

同时发现三个实现缺陷：

- `logger.module.ts` 把 `level / transport / formatters` 展开在 **`Params` 根层级**，
  而 `nestjs-pino` 只消费 `pinoHttp / exclude / forRoutes / useExisting / assignResponse`
  五个键 —— 导致文件输出、日志级别、格式配置**全部被静默忽略**，`logs/` 从未真正写入。
- 文件轮转参数（`rotate / size / count / compress`）写在 `pino/file` 的 `options` 里，
  但 `pino/file`（即 `pino.destination`）不支持这些参数；`error` target 的 `level`
  也写错了层级。二者都会被静默忽略。
- 业务代码 20+ 处使用 NestJS `new Logger()`，但 `main.ts` 没有 `useLogger` 桥接，
  这些日志不进 pino；URL 查询参数（含 OAuth `ticket`/`code`）明文落盘，无脱敏。

约束条件：

- 生产环境为容器部署，日志采集链路依赖 stdout 结构化 JSON；
- 项目已启用类型检查型 ESLint（`recommendedTypeChecked`），日志配置需强类型化；
- 日志属于横切基础设施，变更不得影响业务逻辑与对外 API。

**决策**

将日志收敛为「pino 单一出口」：

1. **HTTP 访问日志**：删除自建 `HttpLoggerMiddleware` 与 `TimingInterceptor`，
   访问日志、状态码分级（5xx=error / 4xx=warn / 其他=info）、慢请求 `[SLOW]` 标记、
   客户端中断（`res.writableEnded === false` 升级为 warn）全部由 `pino-http` 承担。
2. **应用日志桥接**：`main.ts` 使用 `NestFactory.create(AppModule, { bufferLogs: true })`
   \+ `app.useLogger(app.get(Logger))`，使业务代码的 `new Logger()` 也产出结构化日志。
3. **配置层级修正**：pino 的 `level / formatters / transport / redact / mixin`
   一律放进 `pinoHttp` 内部。
4. **文件轮转**：引入 `pino-roll`，按大小轮转 `app.log`；`error` 级别通过
   **target 层 `level: 'error'`** 单独落盘。应用内不做 gzip 压缩。
5. **脱敏**：`pinoHttp.redact` 覆盖请求头凭证与常见敏感字段；新增
   `sanitizeUrl()` 对 URL 的敏感查询参数（token/code/ticket/signature…）脱敏。
6. **健康探针**：`autoLogging.ignore` 过滤 `/api/health`、`/api/health/ready`。
7. **requestId**：HTTP 日志由 `req` 序列化器携带；应用日志由 `pinoHttp.mixin`
   读取 CLS 补全，保证深层代码也能关联请求。

**备选方案**

**保留自建中间件，关闭 pino-http 自动日志（`autoLogging: false`）**
未选用原因：等于放弃框架能力自己维护一套访问日志，`req`/`res` 上下文绑定、
分级、中断处理都要自研，长期维护成本更高。

**应用内自行实现日志轮转**
未选用原因：需要自己维护 worker/文件句柄/重命名竞态，`pino/file` 不支持轮转，
自研属于重复造轮子。

**使用 `pino-rotating-file-stream` 以保留 gzip 压缩**
未选用原因：`pino-roll` 由 pino 生态维护者维护，采用度更高；压缩交由
logrotate / 采集 Agent / 容器日志驱动更符合容器化最佳实践，且不占用应用 CPU/IO。

**影响后果**

收益：

- 同一条请求只产生一条访问日志，统计口径唯一；
- 文件日志、轮转、级别过滤、生产 JSON 真正生效；
- URL 凭证与请求头凭证不再明文落盘；
- 全量日志（含业务 `new Logger()`）进入同一采集链路。

成本：

- 新增依赖 `pino-roll`（需同步更新 `pnpm-lock.yaml`）；
- 移除 `LOG_COMPRESS_OLD_FILES` 配置项，压缩改由外部处理；
- 自建中间件/拦截器被删除，相关单元/集成测试需同步调整。

风险：

- `pino-roll` 并行写多个文件，需确认目标磁盘 IO 可承受；
  → 高流量场景建议改为仅 stdout，由采集链路落盘。
- `pinoHttp.mixin` 依赖 CLS，非 HTTP 上下文（BullMQ / 定时任务）不会带 requestId；
  → 若需要，需用 `PinoLogger.runInContext` 手动开上下文。

**约束要求**

后续实现必须遵守：

- pino 自身配置只能写在 `pinoHttp` 内部，禁止再展开到 `Params` 根层级；
- 传输目标（target）的 `level` 必须写在 target 层，不能写进 `options`；
- 记录 URL 必须经过 `sanitizeUrl()`；记录 body 前需确认不含密码/凭证；
- 新增访问日志能力优先扩展 `pino-http` 配置，禁止再新增自建访问日志中间件。

**验证方式**

1. 启动服务 → 触发一次 2xx / 4xx / 5xx 请求 → 每条请求只产生一条访问日志，级别分别 info/warn/error；
2. 触发超过 `LOG_SLOW_REQUEST_THRESHOLD` 的请求 → 消息带 `[SLOW]`；
3. 客户端主动断开请求 → 产生一条 `warn` 级日志且 `res.writableEnded` 反映中断；
4. 生产配置下 stdout 输出可被 `jq` 解析（合法 JSON）；`logs/app.log` 达到阈值后真实轮转；
5. `logs/error.log` 中不存在 info/warn 级别日志；
6. 请求 `/api/health` 不产生访问日志；
7. 请求 `?ticket=xxx` → 落盘日志中该值显示为 `[REDACTED]`；
8. 业务 `new Logger().log()` 的输出出现在 pino 日志中（含 requestId）。

**日期**
2026-09-11
