# ADR-005：请求/用户上下文基础设施整改为 nestjs-cls

**状态**
已采纳

**背景**

项目原以「手写 `AsyncLocalStorage`」实现两套彼此独立的请求上下文：

- 请求级 store（`cache` / `cacheKey` / `requestId` / `bizCode`）：`src/common/request-context.ts`，
  由 `RequestContextMiddleware` 在最外层 `.run({}, next)` 建立；
- 用户上下文（`User`）：`src/common/context/user-context.ts`，由 `UserContextInterceptor`
  在 JWT 守卫之后 `.run(req.user, next.handle())` 注入。

该实现能跑通，但存在明确的工程债：

1. **隐式执行顺序**：CLS 必须最先挂载，此前仅靠注释约束，无任何机制保证；
2. **两份 ALS 实例、语义分裂**：请求级状态与用户上下文互不相通；非 DI 读取（pino `mixin`）
   只能 import 全局单例，无法 mock；
3. **不可注入、不可测试**：`useRequestUser()` 在非请求链路直接 `throw`，导致业务层遍布
   try/catch 兜底（如 users.service / roles.service）。

约束条件：

- 上下文需在 **Guard**（限流按用户）与 **ExceptionFilter**（写 `bizCode`）中可用；
- `requestId` 的权威口径由 ADR-002 规定为 **pino-http 请求级绑定**（`quietReqLogger` +
  `customAttributeKeys.reqId`），本次迁移必须与之正交、不得引入第二个 id 源；
- 生产运行时为 Node 22（`Dockerfile` 基镜像 `node:22-alpine`），仓库 `engines.node = >=20.19.5`；
- 上下文属横切基础设施，变更不得影响业务规则、接口契约与对外响应体。

**决策**

以 `nestjs-cls` 替换手写 `AsyncLocalStorage`，并提供统一的、可注入的、带类型的上下文门面：

1. 新增 `@Global()` 的 `ContextModule`，`imports` 为
   `ClsModule.forRoot({ global: true, middleware: { mount: true } })`；
   采用 **middleware 挂载**（而非 `ClsInterceptor`），因为本仓库需要在 **Guard**（限流）
   与 **ExceptionFilter**（`bizCode`）中访问上下文——只有 middleware 同时满足。
   **`ContextModule` 必须是 `AppModule` 的第一个 import**，以保证 `ClsMiddleware` 早于
   `RequestIdMiddleware` 与 pino-http 执行。
2. 定义 `AppClsStore extends ClsStore`（`requestId?` / `bizCode?` / `cache?` / `cacheKey?` /
   `user?: User`），统一承载请求级状态与用户上下文；`CacheState` 类型随之迁移至此。
3. 新增可注入门面 `RequestContextService`（包装 `ClsService<AppClsStore>`），作为全应用访问
   上下文的**唯一入口**，暴露与旧实现语义等价的方法：
   - `getUser()` 无则返回 `undefined`；
   - `requireUser()` 无用户时 `throw`（沿用原语义，供业务 try/catch 降级）；
   - `isRequestUser(id)` = `id === requireUser().id.toString()`（保持「无上下文即抛出」行为）；
   - `setUser(user)`、`setCacheState(...)`、`setRequestId(...)`、`setBizCode(...)` 在无上下文时
     **静默忽略**（降级哲学不变）；
   - `getCacheState()` / `getRequestId()` / `getBizCode()` 读操作无上下文时返回空值。
4. **保留** `UserContextInterceptor`（用户信息在 JWT 守卫后才可用），改造为注入门面后在
   `intercept` 中 `setUser(req.user)`，注册位置（`APP_INTERCEPTOR`）不变。
5. requestId 落点收敛到 `ClsMiddleware` **自身**（本节所谓「方案 B」）：启用 nestjs-cls 自带的
   `generateId`，`idGenerator` 复用 `resolveRequestId()`，并在 `setup` 里把同一个 id 写回
   `req.id` / `req.headers['x-request-id']` / 响应头。**删除** `RequestIdMiddleware`——它与
   `idGenerator` 共用同一解析函数、写回同样的三个落点，属性上完全等价；两者并存只会产生
   「同一逻辑两处执行」的重复与潜在覆盖。`setup` **不写 user**（中间件早于守卫执行）。
6. 删除 `src/common/request-context.ts`、`src/common/context/user-context.ts`、
   `src/common/middleware/request-context.middleware.ts`、
   `src/common/middleware/request-id.middleware.ts`；全部调用点改为注入式门面。
7. 门面 `RequestContextService.getRequestId()` 读 `ClsService.getId()`（即 `generateId` 存入
   `CLS_ID` 的 id），不在 store 里另设 `requestId` 字符串 key。
8. 依赖版本 `nestjs-cls@^6.3`（`engines.node >=18`、`@nestjs 10-12`，零引擎冲突）。

**备选方案**

备选方案A：**保留手写 `AsyncLocalStorage`，不引入依赖。**
说明：行为等价性最直接、零新增依赖，但无法解决「不可注入 / 不可测试 / 两份 ALS 实例」问题，
业务层的 try/catch 兜底与隐式顺序约束依旧存在。未选用。

备选方案B：**引入 nestjs-cls，但仅在内部替换、不做 DI 化**（保留 `useRequestUser()` 等函数签名）。
说明：改动面更小，但仍是全局单例导入、仍不可 mock；且无法提供「门面 provider」这一官方推荐模式。
与本次「全面 DI 化重写」的目标不符，未选用。

备选方案C：**保留独立 `RequestIdMiddleware` 处理 requestId（不启用 `generateId`）。**
说明：改动更小、与既有中间件一致，但会让「请求上下文的建立」与「requestId 的生成」分处两套
机制（`ClsMiddleware` 建上下文、另一个中间件写 id），且该中间件依赖 `ClsMiddleware` 先执行才能把
id 写进 CLS——隐式顺序约束无法消除，也无法收敛为单一落点。本次采用方案 B（`generateId` 接管），
未选用本方案。

备选方案D：**使用 `ClsInterceptor` 挂载。**
说明：官方兼容矩阵明确 `ClsInterceptor` 下 **Guard 与 ExceptionFilter 不可用**，而本仓库
恰好需要在这两处访问上下文。直接排除。

备选方案E：**引入 `@nestjs-cls/transactional` 做 Prisma 请求级事务。**
说明：本迁移只聚焦上下文基础设施，不改变数据访问模型；Prisma 请求级事务会扩大事务边界、
影响连接占用与锁竞争，属独立架构决策，本次不做。（后续已由 ADR-006 落地。）

**影响后果**

收益

- 单一 ALS 实例、统一的类型化 store；上下文建立顺序由「模块 import 顺序」保证，而非注释；
- 上下文可注入、可 mock、可测试；门面收敛 key 访问，业务层不再依赖字符串 key；
- 与官方推荐模式一致，后续如需接入插件（如 Prisma 事务、Proxy Provider）有标准扩展点。

成本

- 新增一个运行时依赖（`nestjs-cls@6.x`）；
- 约 30 处业务调用点改为构造注入；
- 各模块构造函数新增一个参数（DI 图变化）。

风险

- **中间件顺序（R1）**：`ClsMiddleware` 必须在最外层最先执行，CLS 上下文才能在后续
  Guard / Interceptor / Filter / pino-http 中可用。requestId 的**取值**与顺序无关
  （`ClsMiddleware.idGenerator` 与 pino-http 的 `genReqId` 共用 `resolveRequestId()`，且都把结果
  写回 `req.id`），故顺序问题只影响「上下文可用性」，不影响「id 一致性」。
  对策：`ContextModule` 置于 `AppModule` 首个 import，并在验证阶段以 e2e 实测响应头 / 响应体 /
  日志中的 `requestId` 一致性；若顺序不可靠，可退回官方「手动挂载」
  （`middleware: { mount: false }` + `consumer.apply(ClsMiddleware)` 置于最前）。
- **等价性边界**：`ClsMiddleware` 内部同样以 `AsyncLocalStorage.run()` 包裹 `next()`，与旧实现
  语义 1:1，因此「长连接 / SSE 因在请求链外 `res.end()` 而丢 CLS」的**既有边界不因迁移改变**；
  `bizCode` 兜底 `requestId` 在 SSE 回调内仍可能缺失（ADR-002 已声明）。
- **WebSocket**：`ClsMiddleware` 官方不支持 WS。WS 路径维持既有回退（`req.user`），不在本次目标内。

**约束要求**

后续实现必须遵守：

- 访问请求上下文一律通过 `RequestContextService` 门面，禁止在业务代码直接注入 `ClsService`
  并硬编码 key；
- `ContextModule` 必须保持在 `AppModule` 的第一个 import 位置；
- requestId 的生成统一由 `ClsMiddleware` 的 `idGenerator` 复用 `resolveRequestId()`，不得另起
  第二处 id 生成；权威口径（pino-http 请求级绑定）仍归 ADR-002；
- `requestId` 的写入落点收敛到 `ClsMiddleware` 的 `setup`，不新增第二处；
- 门面「写」方法在无上下文时静默忽略的降级语义不得移除。

**验证方式**

- 类型检查与构建：`pnpm build` 通过；
- 单测：`pnpm test` 通过（含 `request-context.service.spec.ts` 对「无上下文读返回空 / 写静默忽略 /
  requireUser 抛错」的断言）；
- e2e 冒烟：`pnpm test:e2e` 断言「响应头 `x-request-id`」「响应体 `requestId`」与
  「访问日志顶层 `requestId`」三者一致；带缓存的读接口返回 `X-Cache`；
- 手工核验：SSE `GET /api/jobs/:id/events` 的访问日志仍带顶层 `requestId`；
  4xx 的访问日志顶层带 `bizCode` 且无重复日志；限流按用户维度生效；
  定时任务 / BullMQ 等非请求链路不因读取上下文而抛错。

**日期**
2026-10-14
