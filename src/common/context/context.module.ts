import { Global, Module } from '@nestjs/common';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestContextService } from './request-context.service';
import { resolveRequestId } from '../request-id';

/**
 * 请求上下文基础设施模块（ADR-005）。
 *
 * 职责：
 * - 以 nestjs-cls 的 `ClsMiddleware`（`mount: true`）替换原手写 RequestContextMiddleware，
 *   在请求最外层建立 CLS，使上下文在 Guard / Interceptor / Pipe / Controller / Service /
 *   ExceptionFilter 全链路可用（本仓库在 Guard 里按用户限流、在 ExceptionFilter 里写 bizCode）；
 * - 通过 `@Global()` 暴露门面 RequestContextService，供全应用注入。
 *
 * requestId 落点（ADR-005「方案 B」）：启用 nestjs-cls 自带 id 生成（`generateId`），
 * `idGenerator` 直接复用 `resolveRequestId()`，并在 `setup` 里把同一个 id 写回
 * `req.id` / 请求头 / 响应头三个落点。这样 id 的生成与 pino-http 的 `genReqId` 共用同一解析
 * 函数，两侧必然落在同一个值上——属性上等价于原来的 RequestIdMiddleware，故不再需要它。
 * 注意：`setup` **不写 user**——中间件早于守卫执行，此时 `req.user` 尚未被 JwtAuthGuard 填充；
 * 用户信息仍由 UserContextInterceptor 在守卫之后注入。
 *
 * 顺序约束：本模块**必须是 AppModule 的第一个 import**，以保证 `ClsMiddleware` 早于
 * pino-http 执行、CLS 上下文最先建立（id 取值因共用 `resolveRequestId()` 而与顺序无关）。
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: IncomingMessage) => resolveRequestId(req),
        setup: (cls: ClsService, req: IncomingMessage, res: ServerResponse) => {
          const id = cls.getId();
          // 写回三个落点，与 pino-http 的请求级绑定共用同一个值：
          // - req.id：pino-http 的 `req.id = req.id || genReqId(...)` 会直接复用它；
          // - req.headers：GlobalExceptionsFilter 与 @RequestId() 装饰器读取；
          // - 响应头：回给调用方，便于前端与日志对账。
          req.id = id;
          req.headers['x-request-id'] = id;
          res.setHeader('x-request-id', id);
        },
      },
    }),
  ],
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class ContextModule {}
