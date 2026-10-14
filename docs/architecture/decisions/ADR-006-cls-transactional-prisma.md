# ADR-006：基于 @nestjs-cls/transactional 的 Prisma 事务基础设施

**状态**

已采纳

**背景**

- 全项目交互式事务均为手写 `prisma.$transaction(async (tx) => ...)`，散落 6 个文件共 8 处
  （posts 仓储 2、users 3、roles 3、auth 1、refresh-token 1、job-record 1，含 2 处数组批读形式）。
- 跨 Provider 的事务协作只能靠**手工透传事务句柄**：`RefreshTokenService.issue(user, client?)`
  暴露 `Prisma.TransactionClient` 参数，调用方（login/register/GitHub 登录为基座 client、
  rotate 为 tx）必须各自判断传什么，易漏传导致「以为在事务里、实际已脱事务」。
- ADR-005 备选方案E 已明确「引入 `@nestjs-cls/transactional` 属独立架构决策，本次不做」，
  本 ADR 即该遗留决策的落地。
- 版本约束：`@nestjs-cls/transactional@^4` / adapter-prisma@^2 要求 `nestjs-cls@^7`；
  项目原用 nestjs-cls@^6.3。v7 唯一 breaking 是 exports map（禁止深路径引用，本仓库无此类引用），
  且 engines 要求 Node >=22（Docker 基镜像 node:22-alpine、开发机均为 Node 22，满足）。

**决策**

1. 在 `ContextModule`（ADR-005 的 CLS 模块）的 `ClsModule.forRoot` 中注册事务插件：

   ```ts
   new ClsPluginTransactional({
     imports: [PrismaModule], // 解析 PrismaService 注入令牌（@Global 模块，幂等）
     adapter: new TransactionalAdapterPrisma<PrismaService>({
       prismaInjectionToken: PrismaService,
       sqlFlavor: 'mysql', // 声明存储点语法，为嵌套事务（RequiresNew）提供支持
     }),
   })
   ```

2. 业务代码统一注入 `TransactionHost<TransactionalAdapterPrisma<PrismaService>>`：
   - 开事务：`this.txHost.withTransaction(async () => { const tx = this.txHost.tx; ... })`，
     回调内所有读写必须走 `tx`；
   - 无事务场景（单条读写、`$executeRaw` 原子自增）继续用 `PrismaService`；
   - 数组批读形式 `$transaction([findMany, count])` 用
     `withTransaction(() => Promise.all([tx.a, tx.b]))` 等价替代（同一事务快照语义不变；
     单连接上查询本就串行化，Promise.all 只是写法等价）。
3. 删除手工句柄透传：`RefreshTokenService.issue` 去掉 `client` 参数，内部直接用
   `txHost.tx`——rotate 事务内自动命中当前事务客户端，login/register 直调时回退为
   基座 PrismaService，两种场景语义与旧版一致。
4. 依赖升级：`nestjs-cls ^6.3.1 → ^7.0.1`，新增 `@nestjs-cls/transactional@^4.0.1`、
   `@nestjs-cls/transactional-adapter-prisma@^2.0.1`；`package.json` engines.node
   收紧为 `>=22` 与 nestjs-cls v7 对齐。

**备选方案**

备选方案A：**维持裸 `$transaction` + 手工透传 tx。**
说明：跨 Provider 协作必须显式透传句柄，类型上无法强制（默认参数静默脱事务），
且无统一入口约束团队写法。排除。

备选方案B：**全面改用 `@Transactional()` 声明式装饰器。**
说明：装饰器把事务边界扩大到整个 public 方法——如 `updatePasswordByAdmin` 会把
argon2 哈希（CPU 密集 50-100ms）一并包进事务，拉长 DB 连接占用，违反本仓库
「哈希在事务外」的既定粒度惯例；且装饰器经代理生效，同类自调用不触发，存在隐蔽失效面。
本次选择 `withTransaction` 保持与原 `$transaction` **完全一致的细粒度边界**；
装饰器不禁用，留给后续按方法语义显式选用。

备选方案C：**留在 nestjs-cls v6，搭配 transactional@3 + adapter@1。**
说明：可行且更保守，但停留在旧主版本会持续累积升级债；v7 breaking 与本仓库无交集，
升级成本低，故直接采用最新组合。

**影响后果**

收益

- 事务上下文随 CLS 跨 Provider 传播，消除手工透传 tx 的整类错误；
- 事务入口统一（`withTransaction` / `txHost.tx`），写法可 grep、可评审；
- `sqlFlavor: 'mysql'` 使嵌套事务（Propagation.RequiresNew → SAVEPOINT）开箱可用；
- 顺带完成 nestjs-cls v6→v7 主版本升级，获得 ESM/CJS 双构建与持续维护线。

成本

- 新增 2 个运行时依赖；nestjs-cls 主版本升级；
- engines.node 收紧为 >=22，Node 20 环境不再受支持（生产与 CI 均为 Node 22，无实际影响）。

风险

- `txHost.tx` 在无活动事务时**静默回退**为基座 PrismaService——若调用方误以为处于事务中，
  会脱事务执行。缓解：开事务只经 `withTransaction`，回调内首行固定 `const tx = this.txHost.tx`，
  评审时检查回调外不残留 `tx` 引用；
- 请求外上下文（BullMQ worker、seed）CLS 不激活，上述回退同样生效，语义与直接注入
  PrismaService 一致，无行为变化。

**约束要求**

后续实现必须遵守：

- 新增事务逻辑一律使用 `txHost.withTransaction`，禁止再写裸 `prisma.$transaction`；
- 事务回调内所有 DB 读写必须使用 `this.txHost.tx`，禁止混用 `this.prisma`；
- 禁止为了「省事」在事务外调用 `txHost.tx` 后又假设有事务语义；
- `@Transactional()` 仅在方法内**全部**逻辑都应同事务时使用，且不得依赖同类自调用生效；
- 跨 Service 协作不得再新增 `Prisma.TransactionClient` 类型的透传参数。

**验证方式**

- `pnpm build`（nest build，含全量 TS 类型检查）通过；
- `pnpm test`：`request-context.service.spec.ts` 通过（验证 nestjs-cls v7 运行时兼容）；
  `app.controller.spec.ts` 失败为存量问题（`app.controller.ts` 是空文件，非本次引入）；
- `grep "prisma.\$transaction" src/` 无残留（仅注释中的历史表述）。

**日期**

2026-10-14
