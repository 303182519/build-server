# ADR-001：Job 事件跨实例广播采用 Redis Pub/Sub

**状态**
已采纳

**背景**
任务系统通过 SSE（Server-Sent Events）向前端实时推送 Job 状态变更。
事件广播由 `JobEventsService` 负责，初始实现使用进程内 RxJS `Subject`。

问题：单进程 `Subject` 无法跨实例广播。
当部署多个 NestJS 实例（PM2 / Docker / K8s）时：
- 实例 A 上的 Job 状态变更发布到实例 A 的 `Subject`
- 实例 B 上的 SSE 订阅者收不到该事件
- 用户看到 SSE 连接挂起、永远收不到更新

约束条件：
- Redis 已在项目中用于缓存、限流、分布式锁，基础设施已就绪
- Redis 在本项目中为可选依赖（未配置时自动降级为内存 store）
- SSE 已有 snapshot 机制（连接时推送一次当前状态快照）

**决策**
`JobEventsService` 底层改为 Redis Pub/Sub + 内存 Subject 双层架构：

1. **Redis 可用时**：
   - `publish()` → Redis `PUBLISH` 到共享频道 `job:events`
   - 每个实例各有一个 Redis `SUBSCRIBE` 连接监听该频道
   - 收到消息后推入本地 `Subject`，SSE 订阅者通过 `Subject` 接收
   - 数据格式：`JSON.stringify(IJobSseEvent)`

2. **Redis 不可用时**：
   - `publish()` → 直接推入本地 `Subject`（降级为单实例模式）
   - 行为与改造前完全一致

3. **连接管理**：
   - 使用 `duplicate()` 从现有 `REDIS_CLIENT` 创建两个独立连接（pub / sub）
   - Redis 协议要求 subscriber 连接独占，不能同时执行其他命令
   - 关闭离线队列（`disableOfflineQueue`），断连时立即 reject 而非无限等待
   - `onModuleDestroy` 时优雅关闭连接

**备选方案**

**Redis Streams**
支持消息持久化、回溯、消费者组，功能更强大。
未选用原因：SSE 场景仅需实时推送，不需要历史回溯；Pub/Sub 更轻量，运维成本更低。配合 snapshot 机制已足够覆盖断连期间的消息丢失。

**NATS / RabbitMQ / Kafka**
专业消息中间件，功能完备。
未选用原因：项目已依赖 Redis，引入新中间件增加运维复杂度和资源消耗，收益不匹配。

**数据库轮询**
SSE 订阅者定时查库获取最新状态。
未选用原因：轮询间隔内状态变更不可见（延迟高）；频繁查库增加数据库压力。

**影响后果**

收益：
- 多实例部署下 SSE 订阅者可收到所有实例发布的 Job 事件
- 对外 API 零变更（`publish` / `subscribe` 签名不变），调用方无感知
- Redis 不可用时自动降级，本地开发无需配置 Redis 也能正常运行

成本：
- 每个实例额外占用两个 Redis 连接（pub + sub）
- 事件消息经过 JSON 序列化 / 反序列化，有微小性能开销

风险：
- Redis Pub/Sub 是 fire-and-forget，subscriber 断连期间的消息会丢失
  → 由 SSE snapshot 机制缓解（连接建立时推送一次完整状态快照）
- Redis 断连期间事件降级为仅本实例可见
  → 日志 warn 级别记录，运维可感知

**约束要求**
后续实现必须遵守：
- 频道名必须通过 `KeyPrefixer.prefix()` 生成，保持与项目其他 Redis key 一致的命名空间规范
- 事件消息必须可 JSON 序列化，不传递不可序列化的对象（如 Date 需注意）
- 新增需要跨实例广播的事件类型时，应复用 `JobEventsService` 模式，而非新建独立的 Pub/Sub 通道

**验证方式**
1. 单实例：配置 Redis → 提交 Job → SSE 订阅者收到事件 → 功能正常
2. 多实例：启动两个 NestJS 实例 → 在实例 A 提交 Job → 连接到实例 B 的 SSE 订阅者收到事件
3. Redis 降级：不配置 Redis → 提交 Job → SSE 订阅者仍能收到事件（单实例模式）
4. 优雅关闭：停止应用 → 日志显示 Redis Pub/Sub 连接已关闭，无异常

**日期**
2026-09-05
