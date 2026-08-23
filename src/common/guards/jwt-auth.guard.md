`handleRequest` 是 Passport 的 `AuthGuard` 中的一个方法,它在 token 验证流程完成后被调用。具体来说:

1. 当一个请求到达带有 JWT 认证的路由时
2. `canActivate` 被调用(在当前代码中,如果 `jwtMeta` 为 true 或者是 ws 上下文,会直接返回 true,不会走到 Passport 流程)
3. 如果走到 `super.canActivate(context)`,会触发 Passport 的 JWT 策略
4. Passport 调用 `JwtStrategy.validate()` 方法验证 token
5. 验证完成后(无论成功还是失败),Passport 调用 `handleRequest` 方法,传入 err、user、info 等参数

让我简洁地回答用户。
`handleRequest` 是 Passport 的 `AuthGuard` 在 token 验证流程完成后回调的方法。调用链路如下:

1. 请求到达受 JWT 保护的路由 → `canActivate` 被调用
2. 当代码走到 [jwt-auth.guard.ts:35](file:///e:/project2/build-server/src/common/guards/jwt-auth.guard.ts#L35) 的 `super.canActivate(context)` 时,触发 Passport JWT 策略
3. Passport 调用 `JwtStrategy.validate()` 解析并验证 token
4. 验证流程结束(成功/失败/异常),Passport 回调 `handleRequest(err, user, info, ...)`
   - `err`: strategy 执行中抛出的异常(比如数据库查询报错)
   - `user`: `validate()` 返回的用户对象(token 有效时)
   - `info`: token 无效时的附加信息(如 `jwt expired`、`No auth token` 等)

## 跳过 handleRequest 的情况

注意当前 [canActivate](file:///e:/project2/build-server/src/common/guards/jwt-auth.guard.ts#L18-L36) 中有两处会**直接 return true**,此时 `handleRequest` **不会被调用**:

- WebSocket 上下文(`context.getType() === 'ws'`)→ 交由 `WsJwtGuard` 处理
- 路由/控制器上标了 `@Public()` 或类似 `JWT_META_KEY` 装饰器的(公开接口)

