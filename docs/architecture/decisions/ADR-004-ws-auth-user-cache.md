# ADR-004：WS 消息级鉴权的用户存在性查询引入缓存

**状态**
已采纳

**背景**

`WsJwtGuard.authenticateClient()` 对每条 `@SubscribeMessage` 消息都执行
`usersService.findOneOrThrow()`（`ws-jwt.guard.ts`，查 MySQL `user` 表
`where: { deletedAt: null }`），用于检测用户是否存在或已被软删。

当前限流为每事件 30 次/分钟（`@Throttle`），单用户 DB 压力可接受。但一旦
接入高频事件（如构建日志推送），限流阈值势必抬高，此处会成为 DB 热点，
且无任何降级手段。

约束条件：

- JWT 签名校验必须每条消息执行（无状态、无 DB），保证 token 未被篡改且未过期；
- 软删用户必须能被 WS 链路拒绝（功能正确性要求）；
- 项目已有 `CacheService`（Redis + 内存 fallback），`RedisCacheModule` 为
  `@Global()`，可直接注入；
- access token 过期时间为 15 分钟（`config.default.ts`）。

**决策**

将 WS 消息级鉴权中的「用户存在性查询」包装为 60 秒 Redis 缓存：

1. **JWT 签名校验**：每条消息必做，`jwtService.verify()`，不变更。
2. **用户存在性查询**：通过 `CacheService.wrap(CacheKeys.WS_AUTH_USER(sub),
   () => findOneOrThrow(...), 60)` 读取，TTL 60 秒。
3. **缓存 key**：`ws:auth:user:<userId>`，由 `CacheKeys.WS_AUTH_USER` 统一定义，
   `WsJwtGuard`（读）与 `UsersService.remove`（写失效）共享，避免硬编码散落。
4. **主动失效**：`UsersService.remove()` 软删成功后主动 `DEL` 该 key，使被删
   用户的 WS 连接在下一条消息即被拒绝，而非等待 60s TTL。
5. **错误不缓存**：`findOneOrThrow` 抛出 `USER_NOT_FOUND` 时，`wrap` 的 loader
   抛错不会写入缓存，下次仍查库，保证软删用户不会被错误缓存为「存在」。

**备选方案**

备选方案 A：保持每条消息查库（现状）
- 优点：软删检测零延迟；实现简单。
- 缺点：高频事件下 DB 成为瓶颈，无降级手段；多连接用户每连接独立查库。
- 未选用原因：不可扩展。

备选方案 B：仅连接时鉴权，消息期信任 `client.user`
- 优点：零 DB 查询。
- 缺点：软删后最长 15 分钟（token 过期）才生效，安全窗口过大。
- 未选用原因：安全风险不可接受。

备选方案 C：Guard 内维护内存 `Map<userId, {user, expiresAt}>`
- 优点：不依赖 Redis。
- 缺点：多连接用户每连接独立查库、多实例不共享，缓存命中率低。
- 未选用原因：复用现有 `CacheService` 更优，且 Redis 故障时已自动降级内存。

**影响后果**

收益
- 单用户高频事件下 DB 查询从 `msg_rate` 降至 `1 / 60s`，降幅约 30×；
- 多连接/多实例共享缓存，1 次查询服务该用户所有连接；
- Redis 故障时 `CacheService` 自动降级内存缓存，鉴权不中断。

成本
- 软删后最长 60s 才被 WS 拒绝（主动失效可缩短至下一条消息）；
- `specialRoles` 字段变更最长 60s 后在 WS 链路生效（WS 网关不做权限校验，
  影响可忽略）。

风险
- Redis 故障时降级为内存缓存，软删检测窗口可能略延长，但不超过内存 TTL；
  `CacheService.del` 失败由 60s TTL 兜底，不影响软删主流程。

**约束要求**

后续实现必须遵守：

1. JWT 签名校验每条消息必做，不得缓存或跳过；
2. 缓存 TTL 不得超过 access token 过期时间（15min），推荐 60s；
3. 软删接口必须主动失效 `WS_AUTH_USER` 缓存；
4. loader 抛错不得写入缓存（`CacheService.wrap` 已保证）；
5. 缓存 key 统一由 `CacheKeys.WS_AUTH_USER` 生成，不得硬编码。

**验证方式**

1. **功能**：软删用户后，其 WS 消息最迟在下一条收到 401 并断开；
2. **性能**：单用户高频发消息时，`user` 表查询频率从 `msg_rate` 降至
   `1 / 60s`；
3. **回归**：连接鉴权、各 `@SubscribeMessage`、限流行为不变；
4. **Redis 故障**：缓存降级内存，鉴权仍正常，软删最迟 60s 生效。

**日期**
2026-10-04