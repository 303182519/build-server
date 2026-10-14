# 请求/用户上下文基础设施整改为 nestjs-cls

## 背景（Context）

当前仓库用「手写 `AsyncLocalStorage`」实现了两套彼此独立的请求上下文：

- 请求级 store（`cache` / `cacheKey` / `requestId` / `bizCode`）：[request-context.ts](file:///e:/project2/build-server/src/common/request-context.ts)，由 [request-context.middleware.ts](file:///e:/project2/build-server/src/common/middleware/request-context.middleware.ts) 在最外层 `.run({}, next)` 建立。
- 用户上下文（`User`）：[user-context.ts](file:///e:/project2/build-server/src/common/context/user-context.ts)，由 [user-context.interceptor.ts](file:///e:/project2/build-server/src/common/interceptors/user-context.interceptor.ts) 在 JWT 守卫之后 `.run(req.user, next.handle())` 注入。

这套实现能跑通，但存在明确的工程债（已在上一轮结论中列出并获用户确认整改）：

1. **隐式执行顺序**：CLS 必须最先挂载，目前只靠注释约束（[common.module.ts:46-49](file:///e:/project2/build-server/src/common/common.module.ts#L46-L49)）。
2. **两份 ALS 实例**、语义分裂；非 DI 读取（pino mixin）只能 import 全局单例，不可 mock。
3. **不可注入、不可测试**：`useRequestUser()` 在非请求链路直接 `throw`，导致业务层遍布 try/catch 兜底（[users.service.ts:360](file:///e:/project2/build-server/src/modules/users/users.service.ts#L360)、[roles.service.ts:346](file:///e:/project2/build-server/src/modules/roles/roles.service.ts#L346)）。

用户已明确选择：**全面 DI 化重写**（删除旧函数、改为注入式）；**不引入** Prisma 请求级事务插件（`@nestjs-cls/transactional`）。

## 目标与非目标

**目标**：以 `nestjs-cls` 替换手写 ALS，提供统一的、可注入的、带类型的上下文门面（`ClsService` + 应用门面 `RequestContextService`），并保持所有既有可观测/业务语义**行为等价**。

**非目标**（本次不做）：
- 不引入 Prisma 请求级事务（不接入 `@nestjs-cls/transactional`）。
- 不改变 WebSocket 上下文的既有行为（见「风险与对策 R4」）。
- 不改动业务规则、接口契约、响应体结构。
- 不顺手做无关重构。

## 关键约束（已核实的库能力与仓库事实）

| 事实 | 证据 |
|---|---|
| `ClsMiddleware`（`mount:true`）使 CLS 在 **Guards / Interceptors / Pipes / Controllers / Services / Exception Filters** 全部可用 | nestjs-cls 官方文档「Using a Middleware」 |
| `ClsInterceptor` 下 CLS 在 **Guards 与 Exception Filters 不可用**（不可选） | 官方文档「Compatibility」 |
| `ClsMiddleware` 对 **WebSocket 不支持（✖）** | 官方文档「Compatibility」 |
| 官方明确建议：用「门面 provider」包装 `ClsService`，只暴露应用需要的 API | 官方文档「Type safety and type inference」 |
| 生产运行时为 **Node 22** | [Dockerfile:5](file:///e:/project2/build-server/Dockerfile#L5) `FROM node:22-alpine` |
| 仓库 `engines.node = >=20.19.5`，NestJS 11 | [package.json](file:///e:/project2/build-server/package.json) |
| `nestjs-cls@7.x`：`engines.node >=22`，`@nestjs/* >=10 <=12`，MIT | npm registry `nestjs-cls@7.0.1` |
| `nestjs-cls@6.3 ~ 6.x`：`engines.node >=18`，`@nestjs/* >=10 <=12` | 官方兼容矩阵 |
| `ThrottlerGuard` 构造函数：`(options, storageService, reflector)` | `node_modules/@nestjs/throttler/dist/throttler.guard.d.ts:14` |
| ADR-002 规定：`requestId` 由 **pino-http 请求级绑定**承载（`quietReqLogger` + `customAttributeKeys.reqId`），与本迁移**正交**，不得改动 | [ADR-002](file:///e:/project2/build-server/docs/architecture/decisions/ADR-002-logging-pipeline.md)、[logger.module.ts:234-256](file:///e:/project2/build-server/src/shared/logger/logger.module.ts#L234-L256) |
| `bizCode` 依赖 pino `mixin` 读 CLS 注入（长连接会丢，属已知限制，本次不改变根因） | [logger.module.ts:291-306](file:///e:/project2/build-server/src/shared/logger/logger.module.ts#L291-L306) |

> 核心等价性依据：`ClsMiddleware` 内部同样是 `AsyncLocalStorage.run()` 包裹 `next()`，**与当前 `RequestContextMiddleware` 语义 1:1**。因此「长连接/SSE 丢 CLS」等原有限制**不会因迁移而变化**——这是可保证行为等价的关键。

## 设计决策

### D1. 上下文建立方式：`ClsModule.forRoot({ global: true, middleware: { mount: true } })`
选用 **middleware 挂载**（而非 guard/interceptor），因为本仓库需要在 **Guard**（限流按用户）与 **Exception Filter**（写 `bizCode`）中访问上下文——只有 middleware 同时满足。`mount:true` 对应替换掉原 `RequestContextMiddleware`。

### D2. 类型化 store + 应用门面
- 定义 `AppClsStore extends ClsStore`：`bizCode?` / `cache?` / `cacheKey?` / `user?: User`（`requestId` 不在此另设 key，统一走 `ClsService.getId()`）；`CacheState` 类型随之迁移。
- 新增可注入门面 `RequestContextService`（包装 `ClsService<AppClsStore>`），暴露与旧函数**语义等价**的方法（见 D4）。这既是「DI 化」的落点，也满足官方推荐的「facade provider」模式，避免 30+ 调用点直接依赖 `ClsService` 的字符串 key。

### D3. 门面可见性：新增 `@Global()` 的 `ContextModule`
`CommonModule` 并非 `@Global()`（[common.module.ts:18](file:///e:/project2/build-server/src/common/common.module.ts#L18) 的 `@Global()` 已注释）。为使 `RequestContextService` 可全局注入，新建 `@Global()` 的 `ContextModule`，其 `imports` 放 `ClsModule.forRoot`，并 `providers/exports` 该门面。**`ContextModule` 必须是 `AppModule` 的第一个 import**，以保证 `ClsMiddleware` 最先执行、CLS 上下文在后续 Guard / Filter / pino-http 中可用（id 取值因共用 `resolveRequestId()` 而与顺序无关）。

### D4. 门面方法（语义与旧实现严格对齐）

| 方法 | 语义（对齐旧实现） | 旧来源 |
|---|---|---|
| `getUser(): User \| undefined` | 无则返回 undefined | — |
| `requireUser(): User` | 无用户时 `throw`（沿用原错误语义，供业务 try/catch 降级） | `useRequestUser` |
| `isRequestUser(id: string): boolean` | `id === requireUser().id.toString()`（保持「无上下文即抛出」的既有行为） | `isRequestUser` |
| `setUser(user: User)` | 由用户拦截器调用 | `userContextStorage.run` |
| `getCacheState(): { cache?; cacheKey? }` | 读缓存状态 | `getRequestContext` |
| `setCacheState(state, key?)` | 无上下文时静默忽略（降级哲学不变） | `setCacheState` |
| `getRequestId(): string \| undefined` | 读 `ClsService.getId()`（无上下文返回 undefined） | `getRequestContext().requestId` |
| `setBizCode(code)` | 无上下文时静默忽略 | `setBizCode` |
| `getBizCode(): string \| undefined` | — | `getRequestContext().bizCode` |

### D5. 用户注入时机：保留拦截器（改造为注入式）
用户信息在 JWT 守卫后才可用，故**保留** `UserContextInterceptor`，改为注入 `RequestContextService`，在 `intercept` 中 `setUser(req.user)` 后 `next.handle()`。注册位置（`APP_INTERCEPTOR`）不变。

### D6. requestId：落点收敛到 `ClsMiddleware`（方案 B）
启用 nestjs-cls 自带 id 生成（`generateId: true`）+ `idGenerator: (req) => resolveRequestId(req)`，在 `setup` 里把同一个 id 写回 `req.id` / `req.headers['x-request-id']` / 响应头三处。`resolveRequestId()`（[request-id.ts](file:///e:/project2/build-server/src/common/request-id.ts)）与取值优先级（`req.id` → `X-Request-ID` → 新 UUID）**完全不动**；`genReqId` 与 `idGenerator` 共用同一函数，两侧必然同值。因此**删除** `RequestIdMiddleware`（它写回同样的三处、属性等价，并存只会重复/覆盖）。门面 `getRequestId()` 改读 `cls.getId()`，store 不再另设 `requestId` 键。`setup` **不写 user**（中间件早于守卫，`req.user` 尚未填充）。

### D7. 依赖版本
首选 `nestjs-cls@^6.3`（`engines.node >=18`，`@nestjs 10-12`），**零引擎冲突**且项目为 CommonJS 构建，v6 足够；备选 `^7.0.1`（需将 `package.json` 的 `engines.node` 上调至 `>=22` 与 Docker 对齐）。安装时以 `pnpm view nestjs-cls versions` 确认确切 6.x/7.x 补丁号。

## 实施步骤

### 1) 依赖
- `pnpm add nestjs-cls`（按 D7 选定版本；锁定 `pnpm-lock.yaml`）。

### 2) 新增文件
- `src/common/context/cls-store.ts`：`AppClsStore` 接口、`CacheState` 类型。
- `src/common/context/request-context.service.ts`：`@Injectable()` 门面（D4）。
- `src/common/context/context.module.ts`：`@Global()` 模块，`imports: [ClsModule.forRoot<AppClsStore>({ global: true, middleware: { mount: true, generateId: true, idGenerator: (req) => resolveRequestId(req), setup: 写回 req.id / 请求头 / 响应头 } })]`，`providers/exports: [RequestContextService]`。
- `docs/architecture/decisions/ADR-005-nestjs-cls-request-context.md`：按 ADR-000 模板编写，说明本决策、备选（保留手写实现 / 仅内部替换不 DI 化）、后果与验证。

### 3) 删除文件
- `src/common/request-context.ts`
- `src/common/context/user-context.ts`
- `src/common/middleware/request-context.middleware.ts`
- `src/common/middleware/request-id.middleware.ts`（落点收敛到 `ClsMiddleware`，见 D6）

### 4) 修改文件（上下文基础设施）
| 文件 | 改动 |
|---|---|
| [app.module.ts](file:///e:/project2/build-server/src/app.module.ts) | 首个 import 加入 `ContextModule`（在 `CommonModule`/`LoggerModule` 之前） |
| [common.module.ts](file:///e:/project2/build-server/src/common/common.module.ts) | 移除 `RequestContextMiddleware` 的 `consumer.apply(...)`；保留 `cookieParser`（不再注册 `RequestIdMiddleware`） |
| [request-id.middleware.ts](file:///e:/project2/build-server/src/common/middleware/request-id.middleware.ts) | **删除**：requestId 落点收敛到 `ClsMiddleware` 的 `generateId`/`idGenerator`/`setup`（D6） |
| [user-context.interceptor.ts](file:///e:/project2/build-server/src/common/interceptors/user-context.interceptor.ts) | 构造注入门面，`setUser(req.user)` 替换 `userContextStorage.run` |
| [cache-header.interceptor.ts](file:///e:/project2/build-server/src/common/interceptors/cache-header.interceptor.ts) | 注入门面，`getCacheState()` 替换 `getRequestContext()` |
| [global-exception.filter.ts](file:///e:/project2/build-server/src/common/filters/global-exception.filter.ts#L184-L186) | 注入门面，`setBizCode(...)` 替换旧调用 |
| [logger.module.ts](file:///e:/project2/build-server/src/shared/logger/logger.module.ts#L291-L306) | `mixin` 改为读门面/`ClsService`（`isActive()` 守卫后 `getRequestId/getBizCode`）；同步更新 243-257 行关于「RequestContextMiddleware」的注释 |
| [throttler.guard.ts](file:///e:/project2/build-server/src/shared/throttler/throttler.guard.ts#L54-L62) | 新增构造函数转发 `(options, storageService, reflector)` 给 `super`，并注入门面；`requireUser()` 仍在 try/catch 内，**保留 `req.user` 回退**（WS 路径） |

### 5) 修改文件（业务调用点，逐一替换为注入式）
统一模式（机械替换，不改逻辑）：
- `useRequestUser()` → `this.requestContext.requireUser()`（原 try/catch 降级结构原样保留）
- `isRequestUser(x)` → `this.requestContext.isRequestUser(x)`
- `setCacheState(...)` → `this.requestContext.setCacheState(...)`

涉及文件（约 30 处）：
- [users.service.ts](file:///e:/project2/build-server/src/modules/users/users.service.ts)（L197/212/314/349/352/471/515/532/618/693/707/758 等）
- [roles.service.ts](file:///e:/project2/build-server/src/modules/roles/roles.service.ts)（L261/342）
- [posts.service.ts](file:///e:/project2/build-server/src/modules/posts/posts.service.ts)（L76/88/93/107/110/140/151/156/168/171）
- [jobs.controller.ts](file:///e:/project2/build-server/src/shared/jobs/jobs.controller.ts#L282)
- [agent.controller.ts](file:///e:/project2/build-server/src/modules/agent/agent.controller.ts#L215)

### 6) 文档同步（保持文档真实性）
- 更新 [ADR-002](file:///e:/project2/build-server/docs/architecture/decisions/ADR-002-logging-pipeline.md) 中提及 `RequestContextMiddleware.run()` 的机制描述，加一行「CLS 建立机制已被 ADR-005 替代，`requestId`/`bizCode` 口径不变」。
- 更新 [logger/README.md](file:///e:/project2/build-server/src/shared/logger/README.md) 与 [throttler.note.md](file:///e:/project2/build-server/src/shared/throttler/throttler.note.md) 里对旧实现/旧函数的引用。

## 风险与对策

| ID | 风险 | 对策 |
|---|---|---|
| R1 | **中间件顺序**：`ClsMiddleware` 若晚于 `RequestIdMiddleware`，`cls.set('requestId')` 落不进 store | `ContextModule` 置于 `AppModule` 首个 import；**并在验证阶段实测**。若顺序不可靠，改用官方「手动挂载」：`middleware:{mount:false}` + `consumer.apply(ClsMiddleware)`（`common.module.ts` 最前）或 `main.ts` 的 `app.use(new ClsMiddleware(...).use)` |
| R2 | **既有中间件导致上下文丢失**（官方 issue #50，如放入 `cookieParser` 之后） | 保持 `ClsMiddleware` 在最前；验证阶段确认 `cache`/`bizCode`/`requestId` 均可达 |
| R3 | **ThrottlerGuard 构造函数**：新增第 4 参须正确转发 `super` | 已核实签名 `(options, storageService, reflector)`；按此转发，`pnpm build` 校验类型 |
| R4 | **WebSocket 无 CLS**（`ClsMiddleware ✖ WS`） | 维持现状：WS 走 `req.user` 回退分支；不改动 WS 行为（非目标）。若未来要覆盖 WS，另开 ADR + 在 `WebsocketGateway` 手动绑定 `ClsGuard` |
| R5 | **长连接/SSE 丢 CLS**（`bizCode` 依赖 mixin） | 语义与旧实现等价（同为 `ALS.run` 包裹），**不引入新回归**；`requestId` 仍由 pino 请求级绑定承载（ADR-002），不受影响。验证阶段专门回归 `GET /api/jobs/:id/events` |
| R6 | **引擎冲突**（v7 需 Node>=22） | 首选 v6.3；若选 v7 则同步把 `package.json` `engines.node` 提到 `>=22`（与 Docker `node:22-alpine` 一致） |
| R7 | **非请求链路抛错语义**（cron/BullMQ/测试） | 门面 `requireUser()` 保持「抛错」；`set*` 保持「静默 no-op」。行为等价，业务 try/catch 无需改动 |
| R8 | **测试缺口**：这些横切设施当前几乎无测试 | 高风险管理要求补最小验证（见下）；新增门面单测 + e2e 冒烟（`X-Request-ID` / `X-Cache`）|

## 验证方式

**自动化（必须真实执行）**
1. `pnpm install` → 确认锁文件与依赖树无告警。
2. `pnpm lint`（`recommendedTypeChecked`，含类型检查）。
3. `pnpm build`（`nest build` → tsc 类型检查通过）。
4. `pnpm test` + `pnpm test:e2e`。

**新增测试（高风险管理要求）**
- `request-context.service.spec.ts`：mock `ClsService`，断言 `requireUser()` 无用户抛错、`set*` 无上下文静默、`isRequestUser` 语义。
- e2e 冒烟：断言响应头 `x-request-id` 存在且与响应体/访问日志一致；命中缓存的接口返回 `X-Cache: HIT|MISS`。

**手工回归（关键）**
- REST：`X-Cache`、`x-request-id` 头/体/访问日志三处一致。
- **SSE**：`GET /api/jobs/:id/events` 访问日志顶层 `requestId` 不丢（ADR-002 踩坑点）。
- **4xx**：业务码出现在「响应结束的那条访问日志」顶层 `bizCode`，且**不**产生重复日志。
- **限流**：登录用户按 `userId` 计数；WS 消息仍可用（回退分支）。
- **非请求链路**：cron/BullMQ 触发的 service 不因上下文缺失而中断（`set*` no-op、`requireUser` 抛错被既有 try/catch 捕获）。

## 待确认项（实施前）
1. `nestjs-cls` 版本：**建议 `^6.3`**（无引擎冲突）；若坚持 v7，需一并把 `engines.node` 上调至 `>=22`。
2. 中间件顺序若实测不满足 R1，采用官方「手动挂载」方案（不改变其余设计）。

## ADR
新增 `ADR-005-nestjs-cls-request-context.md`（状态：已采纳；含背景/决策/备选/后果/约束/验证/日期），并在 ADR-002、logger README、throttler note 中补交叉引用。
