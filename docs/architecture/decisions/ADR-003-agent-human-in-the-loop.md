# ADR-003：Agent 人工审批工作流（LangGraph interrupt + Redis Checkpoint + MySQL 审批域）

**状态**
已采纳

**背景**
系统需要引入 LLM Agent 能力：用户给出 prompt，模型（Qwen，经 OpenAI 兼容端点接入）生成内容，但副作用（创建文章草稿）必须经过人工审批后才能执行。流程为：

```
LangGraph → interrupt() → Checkpoint → 审批域（PENDING/APPROVED/REJECTED）
→ Redis Pub/Sub → SSE → 前端 → 用户点击确认 → Command({resume}) → 执行副作用
```

核心约束：
- 图执行必须支持中断 / 恢复（human-in-the-loop），且恢复后状态可跨进程、跨实例还原
- 审批状态是业务权威数据，必须落 MySQL（参见 ADR 总则：MySQL 为权威持久化源）
- Redis 不能作为权威数据源，只承担 checkpoint 与事件广播
- 审批可能被用户重复点击、网络重试 → 必须幂等
- 多实例部署下 SSE 事件必须跨实例可达（与 ADR-001 一致）
- LLM 调用可能超时 / 失败 / 返回非法格式 → 必须有失败路径

**决策**

1. **图编排：LangGraph（@langchain/langgraph）**
   - 状态图：`START → generateDraft → waitForApproval(interrupt) → decideRoute 条件边 → executeSideEffect → END / END`
   - `waitForApproval` 节点调用 `interrupt()` 挂起；用户审批后通过 `graph.invoke(new Command({ resume: { approved, reason } }))` 恢复，resume 值作为 `interrupt()` 返回值注入

2. **Checkpoint 存储：RedisSaver（@langchain/langgraph-checkpoint-redis）**
   - `thread_id` 与审批记录 `threadId` 一一对应
   - 配置 `defaultTTL: 1440` 分钟（24 小时审批窗口）+ `refreshOnRead: true`
   - 要求 Redis 8+（内置 RedisJSON / RediSearch），docker-compose 已升级 `redis:8-alpine`
   - 惰性初始化：首次运行时创建，未配置 Redis 时抛 `AGENT_NOT_CONFIGURED`（503）

3. **审批域：MySQL `agent_approvals` 表为权威源**
   - 状态机：`PENDING → APPROVED | REJECTED`（单向流转）
   - 创建 run 即建行（`payload=NULL` 表示草稿生成中）→ 草稿生成后 `attachDraft` 回填（`updateMany` 限定 `status=PENDING AND payload IS NULL` 防重复回填）
   - 审批操作用 `updateMany({ where: { id, status: PENDING } })` 原子流转，`count=0` 抛 `RUN_NOT_PENDING`（409），天然防并发重复审批
   - 副作用执行结果（postId / error）写入 `result` / `error` / `executedAt`

4. **副作用：复用 PostsService 创建 `status=draft` 文章**
   - Agent 模块不直接操作 posts 表，通过 `PostsModule.exports` 注入 `PostsService`
   - 副作用失败不抛断图，记录 `error` 并发布 `agent.failed` 事件（业务可感知、可重试新一轮 run）

5. **事件广播：AgentEventsService 复用 ADR-001 Redis Pub/Sub 双层模式**
   - 频道 `agent:events`（经 `KeyPrefixer.prefix()`）
   - 事件：`agent.snapshot` / `agent.draft_ready` / `agent.decided` / `agent.completed` / `agent.failed`
   - SSE 端点复用 JobsController 加固模式（连接数上限、心跳 15s、先订阅后快照、teardown 幂等、`@SkipTimeout`）

6. **权限：仅发起人本人可审批**
   - 全局 JWT Guard 保护所有 agent 端点（health 除外）
   - `ApprovalService.decide()` 先校验 `userId` 归属，非本人抛 `RUN_NOT_OWNER`（403）

**备选方案**

**Checkpoint 存 MySQL**
未选用原因：LangGraph checkpoint 读写频繁且结构为二进制/JSON blob，MySQL 无原生 LangGraph checkpointer 实现，需要自行序列化适配，成本高；Redis 是项目既有基础设施且有官方 saver。

**Checkpoint 仅进程内存（MemorySaver）**
未选用原因：进程重启 / 多实例部署时中断状态丢失，无法满足"审批窗口内服务可能部署"的生产场景（AGENTS.md §4：部署期间新旧版本并存）。

**审批状态只放 LangGraph 状态里**
未选用原因：LangGraph checkpoint 有 TTL、可能被清理，且不具备业务查询能力（按用户列表、状态过滤）；审批是业务数据，必须落 MySQL 权威源（AGENTS.md §13/§14）。

**审批通过后同步执行副作用（在 decide 请求内 await）**
未选用原因：副作用（建文章）可能慢 / 失败，阻塞审批请求会拉长 HTTP 响应且失败语义模糊；当前方案 decide 只负责状态流转，resume 异步执行，结果通过 SSE 推送，请求语义清晰。

**影响后果**

收益：
- 人工审批流程有完整审计链：prompt → 草稿 payload → 审批人/时间/理由 → 副作用结果，全部落库可查
- interrupt/resume 是 LangGraph 标准 HITL 模式，后续新增审批类动作（如发文、删除）可在同一图上扩展节点
- 并发审批、重复点击由数据库原子条件兜底，无锁代码
- SSE + snapshot 保证前端刷新 / 断线重连后可恢复完整状态

成本：
- 每个实例额外占用 Redis Pub/Sub 连接（与 JobEvents 模式相同）
- Redis checkpoint 占用内存（24h TTL 自动回收）
- 引入 `@langchain/langgraph`、`@langchain/langgraph-checkpoint-redis`、`@langchain/openai` 三个依赖

风险：
- RedisSaver 依赖 Redis 8+ 的 RedisJSON/RediSearch，低于 8 的环境启动 Agent 功能会失败 → 启动时惰性初始化并在日志明确报错，不影响其他模块
- LLM 输出格式不可控 → `QwenService.parseDraft` 严格校验（JSON 剥离 markdown 围栏、slug 正则、content 最小长度），失败抛错走 FAILED 路径
- Redis Pub/Sub fire-and-forget 丢消息 → SSE snapshot 机制兜底（同 ADR-001）
- 草稿生成后用户长期不审批 → checkpoint 24h 过期，审批记录仍在 MySQL，可查询但无法再 resume；前端应提示重新发起

**约束要求**
后续实现必须遵守：
- 审批域状态流转必须经过 `ApprovalService` 的原子 `updateMany` 条件更新，禁止先查后改（check-then-act）
- LangGraph 图状态只放恢复所需最小字段；业务展示数据以 MySQL `agent_approvals` 为准
- 新增审批类动作类型（action_type）时，副作用执行必须复用既有 Service（如 PostsService），禁止在图节点里直接写 Prisma
- Redis 频道名必须经 `KeyPrefixer.prefix()`，与 ADR-001 一致
- 事件必须可 JSON 序列化；SSE 端点必须复用连接上限 / 心跳 / teardown 加固模式
- LLM 配置（apiKey / baseUrl / model）必须经 `getConfig()` 单一入口读取

**验证方式**
1. 端到端：登录 → `POST /api/agent/runs` → 轮询/SSE 收到 `agent.draft_ready` → `POST decide {approve:true}` → posts 表出现 `status=draft` 新记录，`agent_approvals.result.postId` 一致 → 收到 `agent.completed`
2. 拒绝流：`approve:false` → 状态 REJECTED，`executedAt/result` 为空，posts 表无新增
3. 幂等：同一 run 二次 decide → 409 `RUN_NOT_PENDING`
4. 越权：非发起人 decide → 403 `RUN_NOT_OWNER`
5. 降级：未配置 Qwen 环境变量 → 启动 run 返回 503 `AGENT_NOT_CONFIGURED`
6. 构建与静态检查：`pnpm build` 通过，`pnpm lint` 无新增错误

**日期**
2026-09-25
