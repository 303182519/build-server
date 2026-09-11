import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { resolveRequestId } from '../request-id';
import { setRequestId } from '../request-context';
// 给每个请求挂一个 requestId，Filter / Interceptor / Logger 都能拿到
// 上游如果已经带了 x-request-id（如网关注入），就尊重它，方便链路追踪
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // 与 pino-http 的 genReqId 共用同一解析函数：两侧必须落在同一个值上，
    // 否则「访问日志里的 requestId」与「响应头 / 响应体里的 requestId」会不一致。
    const id = resolveRequestId(req);
    // 写回三个落点：
    // - req.id：pino-http 的 `req.id = req.id || genReqId(...)` 会直接复用它，
    //   请求级 logger 绑定（见 logger.module.ts）也取自它；
    // - req.headers：GlobalExceptionsFilter 与 @RequestId() 装饰器读取；
    // - 响应头：回给调用方，便于前端与日志对账。
    req.id = id;
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    // 同步把 requestId 写进 CLS。这样「拿不到 req 的深层代码」（service / 异步回调）
    // 也能凭 CLS 让 pino 的 mixin 把 requestId 挂到日志上——链路追踪在单进程内闭环。
    // 前提：RequestContextMiddleware 必须在它之前运行（已在 CommonModule 里排在最外层）。
    setRequestId(id);
    next();
  }
}
