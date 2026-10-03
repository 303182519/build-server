# Socket 模块使用说明

基于 Socket.IO v4 + NestJS WebSocket Gateway 的实时通信模块，提供 JWT 鉴权、房间（Room）、点对点私信、全局广播能力，事件全程 TypeScript 类型安全。

## 目录结构

```
src/modules/socket/
├── socket.module.ts            # 模块定义（导入 UsersModule + JwtModule，导出 SocketService）
├── socket.gateway.ts           # Gateway：连接生命周期 + 5 个客户端事件处理器
├── socket.service.ts           # 连接注册表：Map<userId, Set<Socket>>，sendToUser 封装
├── dto/index.ts                # 入参校验 DTO（class-validator，白名单过滤）
├── interface/
│   ├── auth-socket.ts          # AuthSocket：携带脱敏 user 的扩展 Socket 类型
│   └── socket-event.types.ts   # ClientToServerEvents / ServerToClientEvents / AckResponse
└── NOTE.md                     # Socket.IO 核心概念与设计笔记
```

依赖的公共设施（位于 `src/common/`）：

- `WsJwtGuard`（guards/ws-jwt.guard.ts）：连接鉴权与消息鉴权共用的单一事实源
- `WsExceptionFilter`（filters/ws-exception.filter.ts）：统一错误信封 `{ status, message, code? }`

## 当前状态（重要）

- **SocketModule 尚未注册**：`src/modules/index.ts` 的 `modules` 数组中还没有 `SocketModule`，Gateway 当前**不会**随应用启动。启用前需手动加入：

```typescript
// src/modules/index.ts
import { SocketModule } from './socket/socket.module';

export const modules = [
  // ...
  SocketModule,
];
```

- 后端依赖已就绪：`@nestjs/websockets`、`@nestjs/platform-socket.io`、`socket.io@^4.8.4`
- 前端仓库（building-web）**尚未安装** `socket.io-client`，接入时需先安装：

```bash
npm install socket.io-client
```

- 当前连接注册表为内存 `Map`，仅支持**单实例部署**；多实例需引入 `@socket.io/redis-adapter`（见文末）。

## 后端架构

### 请求处理链路

```
客户端连接（namespace: /socket）
    │
    ▼
handleConnection()                     ← @UseGuards 对生命周期方法不生效
    │  手动调用 wsJwtGuard.authenticateClient()
    │  提取 token → 验证 JWT → 查询用户 → 挂载 client.user
    ├─ 成功 → SocketService.handleConnection() 注册连接
    │        → emit('connected') 欢迎，broadcast('user-joined')
    └─ 失败 → emit('exception', { status: 401 ... }, ack)
             5 秒宽限期（等客户端读错误/回 ack）后强制断开
    │
    ▼
@SubscribeMessage 消息处理             ← WsJwtGuard + ValidationPipe + WsExceptionFilter
    │  守卫自动重新鉴权（每条消息独立校验）
    │  DTO 白名单校验（未知属性剔除、超长拒绝）
    └─ 返回值自动作为 ACK 回调发给客户端
    │
    ▼
handleDisconnect()
    │  移除注册；仅当该用户已无任何活跃连接时才广播 user-left
```

### 鉴权细节

Token 提取优先级（`extractWsToken`）：

1. `handshake.auth.token` — Socket.IO 推荐方式
2. `handshake.headers.authorization: Bearer <token>` — HTTP 兼容方式

失败错误码统一走 `ErrorExceptionMap`：

| code | 场景 |
| --- | --- |
| `INVALID_ACCESS_TOKEN` | token 缺失或校验失败 |
| `ACCESS_TOKEN_EXPIRED` | token 过期（`TokenExpiredError`） |
| `USER_NOT_FOUND` | 用户不存在或已软删除 |

连接期失败：`exception` 事件下发 + 5 秒后强制断开（防未认证连接悬挂反复触发鉴权查询）。
消息期失败：由 `WsExceptionFilter` 捕获，见下方「错误通道」。

### 资源保护

| 机制 | 配置 |
| --- | --- |
| 消息限流（join/leave/send-to-room/send-to-user） | `@Throttle` 60 秒 30 次 |
| 广播限流（broadcast） | 60 秒 5 次（广播放大 N-1 倍流量） |
| 单用户并发连接上限 | 10 个，超出踢掉最早连接（emit 429 后断开，客户端自动重连） |
| 房间名长度 | ≤ 100 字符 |
| 消息长度 | ≤ 2000 字符 |

## 事件协议

连接地址：`<服务端地址>/socket`（namespace）。

### 客户端 → 服务端（均返回 AckResponse）

| 事件 | Payload | 行为 |
| --- | --- | --- |
| `join-room` | `{ room }` | 加入房间，回 `room-joined`，向房间广播 `room-user-joined` |
| `leave-room` | `{ room }` | 离开房间，回 `room-left`，向房间广播 `room-user-left` |
| `send-to-room` | `{ room, message }` | 向房间内**其他人**投递 `room-message` |
| `send-to-user` | `{ targetUserId, message }` | 向目标用户**所有连接**投递 `direct-message`；目标不在线返回 `{ success: false }` |
| `broadcast` | `{ message }` | 向除自己外的所有客户端投递 `broadcast-message` |

AckResponse 结构：

```typescript
interface AckResponse {
  success: boolean;
  message?: string;   // 失败原因
  status?: number;    // 失败时附带 HTTP 风格状态码
  code?: string;      // 失败时附带业务错误码
}
```

### 服务端 → 客户端

| 事件 | Payload | 触发时机 |
| --- | --- | --- |
| `connected` | `{ message, userId, username }` | 连接鉴权成功 |
| `user-joined` | `{ userId, username }` | 新用户上线（不含自己） |
| `user-left` | `{ userId, username }` | 用户的**最后一个**连接断开 |
| `room-joined` / `room-left` | `{ room }` | 自己加入/离开房间成功 |
| `room-user-joined` / `room-user-left` | `{ room, userId, username }` | 房间内其他人进出 |
| `room-message` | `{ room, message, senderId, senderUsername, timestamp }` | 房间消息 |
| `direct-message` | `{ message, senderId, senderUsername, timestamp }` | 私信 |
| `broadcast-message` | `{ message, senderId, senderUsername, timestamp }` | 广播 |
| `exception` | `{ status, message, code? }` | 错误通道（见下） |

### 错误通道（两条路径互斥）

| 客户端 emit 方式 | 错误返回路径 | 典型触发 |
| --- | --- | --- |
| `emitWithAck` / 带 ack 回调 | ack 返回 `{ success: false, status, message, code? }` | 参数校验 400、限流 429、目标不在线 |
| `emit`（不带 ack） | `exception` 事件 `{ status, message, code? }` | 同上 |

约束：

- 使用 `emitWithAck` 时**必须**处理 `success === false`，失败时不会收到 `exception` 事件。
- 连接鉴权失败始终走 `exception` 事件（此时无 ack 上下文）；客户端收到 `status === 401` 应刷新 token 后重连。

## 前端接入示例

### 1. 类型导入

前后端事件类型同构。前端可直接从后端仓库复制 `socket-event.types.ts`，或通过共享包引入：

```typescript
// types/socket-events.ts —— 与后端 src/modules/socket/interface/socket-event.types.ts 保持一致
export interface ServerToClientEvents { /* ... 同后端 ... */ }
export interface ClientToServerEvents { /* ... 同后端 ... */ }
export interface AckResponse { success: boolean; message?: string; status?: number; code?: string; }
```

### 2. 建立连接（React Hook）

```typescript
// hooks/useSocket.ts
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@/types/socket-events';

export function useSocket(getToken: () => Promise<string>) {
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

    (async () => {
      const token = await getToken();
      socket = io(`${import.meta.env.VITE_API_URL}/socket`, {
        auth: { token },                      // 鉴权 token
        transports: ['websocket', 'polling'], // 降级兜底
      });
      if (disposed) { socket.disconnect(); return; }
      socketRef.current = socket;

      socket.on('connect', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));

      // token 过期：刷新后重连
      socket.on('exception', async (error) => {
        if (error.status === 401) {
          const newToken = await getToken();   // 内部应先刷新 access token
          socket!.auth = { token: newToken };
          socket!.disconnect();
          socket!.connect();
        }
      });
    })();

    return () => {
      disposed = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [getToken]);

  return { socket: socketRef, connected };
}
```

### 3. 收发消息

```typescript
const { socket } = useSocket(getToken);

// —— 订阅服务端事件（data 自动推导类型）——
socket.current?.on('connected', (data) => console.log(data.username, '已连接'));
socket.current?.on('direct-message', (data) => {
  // { message, senderId, senderUsername, timestamp }
});
socket.current?.on('room-message', (data) => {
  // { room, message, senderId, senderUsername, timestamp }
});

// —— 发送：带 ack 的写操作必须检查 success ——
const res = await socket.current?.emitWithAck('send-to-user', {
  targetUserId: '123',
  message: 'hello',
});
if (res && !res.success) {
  // res.status === 429 → 触发限流；res.message → 失败原因
}

// —— 房间操作 ——
await socket.current?.emitWithAck('join-room', { room: 'project-42' });
socket.current?.emit('send-to-room', { room: 'project-42', message: 'hi all' });
```

### 4. 与 React Query / Zustand 的边界

- `direct-message` / `room-message` 到达后如需落地为服务端状态，写入 TanStack React Query 缓存（如 `queryClient.setQueryData` 或 `invalidateQueries`），不要自建平行数据源。
- 「连接状态、未读闪烁」这类纯客户端 UI 状态放 Zustand 或组件局部 state。

## 服务端内部调用（其他模块如何向用户推送）

`SocketModule` 导出了 `SocketService`，业务模块（如 Agent 任务完成通知）注入后即可主动推送：

```typescript
// 任意业务 Service
constructor(private readonly socketService: SocketService) {}

notifyUser(userId: bigint, payload: unknown): void {
  const delivered = this.socketService.sendToUser(
    userId.toString(),
    'direct-message',   // 建议扩展专门的业务事件名，并同步补 ServerToClientEvents 类型
    payload,
  );
  // delivered === false：用户当前不在线，业务上应降级（落库 / 稍后重试），不能当作投递成功
}
```

可用查询接口：`isConnected(userId)`、`getConnectedUserIds()`。

## 多实例部署（TODO）

当前 `connectedClients` 为进程内存 Map，负载均衡多副本场景下 `send-to-user` 只能命中本实例上的连接。扩展方案：

```bash
npm install @socket.io/redis-adapter
```

在 Gateway `afterInit` 中接入 Redis adapter；`SocketService` 的集合遍历已收敛在 `sendToUser` 内部，届时仅需改造该层（改用 `server.to('user:<id>')` 房间或 adapter 跨实例投递）。

## 常见问题

- **为什么连接后还要每条消息鉴权？** `@UseGuards` 对 `handleConnection` 不生效，连接期是手动验证；消息期由 `WsJwtGuard` 在管道中再次校验，两条路径共用 `authenticateClient()` 单一事实源。
- **`join()` / `leave()` 是异步的**，Socket.IO v4 返回 Promise，必须 `await`。
- **CORS**：当前 `cors: { origin: '*' }` 仅限开发；生产环境应改为具体域名白名单。
- **多标签页**：同一用户多连接正常共存，`user-left` 只在最后一个连接断开时广播；连接数超过 10 个会踢掉最旧的标签页。
