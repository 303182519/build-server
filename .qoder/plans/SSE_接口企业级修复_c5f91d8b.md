# SSE 接口企业级修复

## 现状分析

`GET /jobs/:id/events` 接口存在 7 个问题，按风险排序：

| # | 问题 | 风险 |
|---|------|------|
| 1 | SSE 头已发送后才 `await getById`，若抛异常则无法返回正确 HTTP 状态码，客户端收到 200 后流断裂 | 高 |
| 2 | subscribe 回调在 `await getById` 期间可能收到终态事件并 `endStream()`，之后第 83 行 `res.write` 触发 `ERR_STREAM_WRITE_AFTER_END` | 高 |
| 3 | 无权限校验，任意已认证用户可订阅任意 job 事件 | 高 |
| 4 | 无 SSE 心跳，生产环境被 Nginx/Ingress 空闲超时断连 | 中 |
| 5 | `res.write` 异常未捕获，半开连接写入导致 uncaught exception | 中 |
| 6 | 无并发 SSE 连接数限制，可被 DoS | 中 |
| 7 | `id` 参数无雪花格式校验，无效 id 穿透到 DB | 低 |

## 修复方案

### 1. 调整执行顺序 + 空指针/竞态修复（问题 1、2）

**文件**: `src/shared/jobs/jobs.controller.ts`

**核心思路**：先查 snapshot 并校验权限，再发送 SSE 头，最后订阅事件流。

```
执行顺序调整为：
1. ParseSnowflakePipe 校验 id
2. await getById(id) → 失败则抛异常，NestJS 正常返回 404（此时还没发 SSE 头）
3. 权限校验（createdBy 比对）
4. 发送 SSE 响应头
5. 订阅事件流
6. 发送 snapshot 事件
```

**竞态防护**：引入 `closed` 标志位，所有 `res.write` 前检查标志位，`endStream` 时设为 true，防止 write-after-end。

### 2. 权限校验（问题 3）

**文件**: `src/shared/jobs/jobs.controller.ts`

**方案**：校验 `snapshot.createdBy === 当前用户 id`。不匹配则抛 `FORBIDDEN`。
- 通过 `useRequestUser()` 获取当前用户
- `JobRun.createdBy` 字段为 `string | null`（系统任务可能无创建者）
- 若 `createdBy` 为 null（系统触发任务），允许所有已认证用户查看
- 若 `createdBy` 有值，必须匹配当前用户 id

### 3. SSE 心跳保活（问题 4）

**文件**: `src/shared/jobs/jobs.controller.ts`

**方案**：每 15 秒发送 SSE 注释行 `: heartbeat\n\n`，连接关闭时清除定时器。

```ts
const heartbeatInterval = setInterval(() => {
  safeWrite(': heartbeat\n\n');
}, 15_000);
```

### 4. safeWrite 封装（问题 5）

**文件**: `src/shared/jobs/jobs.controller.ts`

**方案**：封装 `safeWrite(chunk: string)` 方法，内部检查 `closed` 标志 + try/catch 包裹 `res.write`，失败时标记 closed 并清理资源。

### 5. 并发连接数限制（问题 6）

**文件**: `src/shared/jobs/jobs.controller.ts`

**方案**：在 Controller 层用模块级计数器追踪当前活跃 SSE 连接数，超过上限（默认 100）直接返回 `503 Service Unavailable`（此时尚未发送 SSE 头，可正常返回 HTTP 错误）。

### 6. id 参数校验（问题 7）

**文件**: `src/shared/jobs/jobs.controller.ts`

**方案**：`@Param('id', ParseSnowflakePipe)` 校验 id 格式。注意 `ParseSnowflakePipe` 返回 `bigint`，但 `getById` 接受 `string`，需 `String(bigintId)` 转换。

## 涉及文件

| 文件 | 变更类型 |
|------|----------|
| `src/shared/jobs/jobs.controller.ts` | 修改（主要变更） |

## 验证手段

1. `npx tsc --noEmit` — 类型检查通过
2. `npx nest build` — 构建通过
3. 人工审查：确认所有 `res.write` 调用都在 `closed` 检查之后
4. 人工审查：确认 SSE 头在所有校验通过之后才发送
