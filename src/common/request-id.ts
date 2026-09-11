import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * 解析本次请求的 requestId —— 全链路唯一真相源。
 *
 * 为什么必须共用：`RequestIdMiddleware` 与 pino-http 的 `genReqId` 都会给请求分配 id。
 * 两处各自 `randomUUID()` 时会得到**两个不同的值**，于是「访问日志里的 requestId」
 * 与「响应头 `x-request-id` / 响应体 `requestId` / CLS 里的 requestId」对不上，
 * 链路追踪在这一跳直接断掉。因此两个入口必须调用同一个解析函数。
 *
 * 取值优先级：
 * 1. `req.id`：pino-http 已经分配过（其内部是 `req.id = req.id || genReqId(req, res)`），复用它；
 * 2. `X-Request-ID` 请求头：上游（网关 / 调用方）已透传，尊重它，便于跨系统串联；
 * 3. 新建 UUID。
 *
 * 与执行顺序无关：两个入口都会把结果写回 `req.id` 与 `req.headers['x-request-id']`，
 * 因此无论 pino-http 中间件与 `RequestIdMiddleware` 谁先运行，最终都收敛到同一个值。
 */
export function resolveRequestId(req: IncomingMessage): string {
  const assigned = req.id;
  if (typeof assigned === 'string' && assigned) return assigned;

  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && incoming) return incoming;

  return randomUUID();
}
