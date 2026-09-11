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
   脱敏路径必须按 access log 的**顶层键名**书写（`customAttributeKeys` 已把请求 / 响应重命名为
   `request` / `response`），并统一使用 `*.` 通配前缀 —— `req.` / `res.` 前缀永远无法命中
   （详见「决策」第 10 条）。
6. **健康探针**：`autoLogging.ignore` 过滤 `/api/health`、`/api/health/ready`。
7. **请求上下文字段**：`requestId` 与 `bizCode` 统一由 `pinoHttp.mixin` 读取 CLS 注入
   **顶层**，全链路只保留这一条字段路径。`req` 序列化器不再输出 `request.requestId`
   （此前上游带 `X-Request-ID` 时同一维度会出现两条路径）。
8. **日志归属与去重**：HTTP 维度（`request.method` / `request.url` / `response.statusCode` /
   `responseTime`）只由访问日志承载；`GlobalExceptionsFilter` 只把业务码写进 CLS（由 mixin
   注入访问日志），**不再单独产出 4xx 日志**；仅 5xx 额外产出一条 error 日志承载异常堆栈。
9. **异常序列化**：`serializers` 显式注册 `err: stdSerializers.err`。pino 默认不序列化
   `Error` 实例，缺失该注册时 `{ err: exception }` 会落成 `{}`，导致 5xx 的 message / stack 丢失。
10. **访问日志请求头白名单**：`req` 序列化器只输出 `method` / `url` / `userAgent` / `contentType`
    四个字段，**不整包输出 `req.headers`**。规范化后的请求对象确实含 `headers`，但：请求头里
    绝大多数内容是凭证（`authorization` / `cookie` / `x-api-key`）或 PII；`cookie` 常有 KB 级体积，
    而访问日志是最高频日志，单条增量 × 日均请求量直接决定存储与采集成本；`user-agent` / `referer`
    基数极高，作为可检索字段会撑大索引且对告警几乎没有价值；请求头完全由客户端控制，属不可信输入。
    `referer` 亦不记入 —— 它可能携带一次性凭据，而 `sanitizeUrl()` 只覆盖 query，path 段无法脱敏，
    收益低于风险。
    与之配套，`redact` 中的请求头路径改用 `*.headers.*` 通配前缀：既修正了原先失效的 `req.` / `res.`
    前缀，也不再为 `request` / `response` 这两个顶层键单独生成脱敏 stringifier —— pino 的脱敏
    stringifier 按**顶层键**选取，`*.` 前缀统一由 wildcardFirst stringifier 处理；混用具体前缀与
    通配前缀时二者的优先关系属于实现细节，不应依赖。

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

**访问日志整体输出 `req.headers`**
未选用原因：请求头中大量字段属凭证 / PII（`authorization` / `cookie` / `x-api-key`），
`cookie` 常有 KB 级体积而访问日志是最高频日志，`user-agent` / `referer` 基数极高会撑大检索索引，
且请求头是客户端可控的不可信输入。改由白名单显式列举（见「决策」第 10 条），
并以结构化字段而非原始对象承载。

**影响后果**

收益：

- 同一条请求只产生一条访问日志，统计口径唯一；
- 文件日志、轮转、级别过滤、生产 JSON 真正生效；
- URL 凭证与请求头凭证不再明文落盘（访问日志只输出请求头白名单，`redact` 的请求头路径亦已修正为可命中的形式）；
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
- 新增访问日志能力优先扩展 `pino-http` 配置，禁止再新增自建访问日志中间件；
- 同一维度只允许一条字段路径：HTTP 维度只由访问日志输出，`requestId` / `bizCode` 只输出在顶层，
  异常堆栈 `err` 只出现在 5xx 错误日志；
- 应用日志禁止使用 `request` / `response` 作为键名 —— 这两个键已被 pino-http 的序列化器占用
  （`customAttributeKeys`），值会被 `pino-std-serializers` 的内置序列化器二次处理；
- 访问日志的请求头只允许输出白名单字段（当前为 `userAgent` / `contentType`），
  禁止把 `req.headers` 整体塞进日志；新增字段需同步更新本节与 logger README 的字段契约表；
- `redact.paths` 必须使用 access log 的**顶层键名**，并统一使用 `*.` 通配前缀
  （`req.headers.*` / `res.headers.*` 永远命中不到；`request.` 这类具体前缀会与 `*.xxx` 通配路径混用）；
- 预期内的 4xx 不得再新增第二条日志（响应结束的那条访问日志即为权威记录）。

**验证方式**

1. 启动服务 → 触发一次 2xx / 4xx / 5xx 请求 → 2xx / 4xx 各只产生一条访问日志（级别 info / warn）
   且顶层带 `bizCode`；5xx 额外产生一条异常过滤器 error 日志（含非空 `err.stack`），
   两条日志共享同一个 `requestId`；
2. 触发超过 `LOG_SLOW_REQUEST_THRESHOLD` 的请求 → 消息带 `[SLOW]`；
3. 客户端主动断开请求 → 产生一条 `warn` 级日志且 `res.writableEnded` 反映中断；
4. 生产配置下 stdout 输出可被 `jq` 解析（合法 JSON）；`logs/app.log` 达到阈值后真实轮转；
5. `logs/error.log` 中不存在 info/warn 级别日志；
6. 请求 `/api/health` 不产生访问日志；
7. 请求 `?ticket=xxx` → 落盘日志中该值显示为 `[REDACTED]`；
8. 业务 `new Logger().log()` 的输出出现在 pino 日志中（含 requestId）；
9. 带 `Authorization` / `Cookie` / `X-Api-Key` 请求头的请求 → 落盘日志中**不出现**这些原始值，
   访问日志含 `request.userAgent` / `request.contentType` 且**不含** `request.headers`；
10. 把 `{ headers: req.headers }` 之类对象交给 logger → 其中 `authorization` / `cookie` 落为 `[REDACTED]`。

**日期**
2026-09-11

**修订记录**

- **2026-09-11**：移除「请求到达」访问日志（删除 `pinoHttp.customReceivedMessage`）。
  此前每请求产出两条访问日志（到达行 + 结束行），与本文档「每条请求只产生一条访问日志」
  的验证标准（见「验证方式」第 1 条）相悖。到达行不含状态码 / 耗时等结果信息，会让日志量
  翻倍、稀释检索并污染基于 `level` 的告警；请求开始 / 结束的配对交由 APM / 追踪链路承担。
  随之 `customLogLevel` 恢复为「未正常结束即 warn」的简单判定（该函数不再被「到达」时点调用）。
  注意：pino-http 无 `customReceivedLogLevel` 选项，若将来重新引入到达日志，必须重新区分
  两个调用时点，否则到达日志会被判成 `warn`。
- **2026-09-11**：明确慢请求的级别口径 —— 超过 `LOG_SLOW_REQUEST_THRESHOLD` 只追加
  `[SLOW]` 标记，**级别保持 info 不变**（与本文档「决策」第 1 条一致）。此前
  `.env` 与 `configuration.interface.ts` 的注释误写为「记录为 warn 级别」，已按本文档修正。
  原因：`pino-http` 的 `customLogLevel(req, res, err)` 拿不到 `responseTime`，若在其中另算耗时
  会与日志里的 `responseTime` 字段形成第二个时间源，阈值边界可能不一致；
  且「慢」不等于「失败」，不应污染 warn / error 告警。慢请求告警应在采集侧按
  `[SLOW]` / `responseTime` 单独配置。
- **2026-09-11**：收敛字段契约、消除 4xx 双写（新增「决策」第 7/8/9 条）。
  起因：一次 401 请求产出两条重复的 warn 日志（异常过滤器 + 访问日志），且同一维度出现两套
  字段路径（`status` vs `response.statusCode`、`request.url` vs 顶层 `url`），采集侧要为告警 /
  看板写两套规则；同时发现 5xx 日志的 `{ err: exception }` 实际落成 `{}`（`serializers` 只按
  pino-http 的 `errKey='error'` 注册，`'err'` 键无序列化器），堆栈一直是丢的。
  变更：`GlobalExceptionsFilter` 不再产 4xx 日志，改为把 `bizCode` 写入 CLS 并由 `mixin` 注入
  访问日志顶层；`req` 序列化器移除 `requestId`（requestId 统一只在顶层）；5xx 错误日志不再重复
  HTTP 维度（只留 `bizCode` / `requestId` / `err`），靠 `requestId` 与访问日志关联；
  `serializers` 注册 `err: stdSerializers.err` 修复堆栈丢失。
  代价：5xx 场景需按 `requestId` 关联两条日志；`LOG_INCLUDE_CONTEXT=false` 时访问日志将同时
  失去顶层 `requestId` 与 `bizCode`（4xx 业务语义随之丢失），已在 logger README 中标注。
  未做（另需前置决策）：`clientIp` / `userAgent`（需先确定 trust proxy 层数）、
  `env` / `service.version`（需确定版本来源）、`traceId`（需引入 OpenTelemetry）。
- **2026-09-11**：修正脱敏路径失效，并为访问日志增加请求头白名单（新增「决策」第 10 条）。
  起因：核查 `req` 序列化器时发现 `redact.paths` 中的 `req.headers.authorization` /
  `req.headers.cookie` / `res.headers["set-cookie"]` **从未生效** —— `customAttributeKeys` 已把
  pino-http 的绑定键改成 `request` / `response`，而 pino 的脱敏 stringifier 按顶层键选取，
  这三条路径永远匹配不到。此前之所以没有泄露，只是因为 `req` 序列化器压根没输出 headers，
  属「配置写了但等于没写」的虚假安全感（一旦有人按「有 redact 兜底」的直觉补上 `headers`，
  凭证会明文落盘）。
  变更：① 路径改为 `*.headers.authorization` / `*.headers.cookie` / `*.headers["set-cookie"]`
  —— 用 `*.` 统一前缀而非 `request.` / `response.`，既避免为这两个顶层键单独生成 stringifier
  而与已有 `*.xxx` 通配路径产生依赖实现细节的优先关系，也顺带覆盖任何「误把 headers 放进日志对象」
  的场景；② `req` 序列化器的白名单补上 `userAgent` / `contentType`（`referer` 因 `sanitizeUrl()`
  不覆盖 path 段、可能残留一次性凭据而明确排除）；③ logger README 新增「访问日志的请求头白名单」
  小节，修正脱敏章节的失效描述，并新增「脱敏不生效」故障排查条目。
  影响：访问日志每条新增 `request.userAgent` / `request.contentType` 两个字段（低基数、纯文本，
  不建议建索引）；单条日志体积随 UA 长度小幅增长，需计入容量评估。
  未做：`clientIp`（仍待 trust proxy 层数决策）；`referer`（见上）。
