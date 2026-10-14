import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { RequestContextService } from './request-context.service';

/**
 * 请求上下文基础设施模块（ADR-005）。
 *
 * 职责：
 * - 以 nestjs-cls 的 `ClsMiddleware`（`mount: true`）替换原手写 RequestContextMiddleware，
 *   在请求最外层建立 CLS，使上下文在 Guard / Interceptor / Pipe / Controller / Service /
 *   ExceptionFilter 全链路可用（本仓库在 Guard 里按用户限流、在 ExceptionFilter 里写 bizCode）；
 * - 通过 `@Global()` 暴露门面 RequestContextService，供全应用注入。
 *
 * 顺序约束（关键）：本模块**必须是 AppModule 的第一个 import**，以保证 ClsMiddleware
 * 先于 RequestIdMiddleware 与 pino-http 执行——RequestIdMiddleware 需要往 CLS 写 requestId。
 *
 * 注意：不启用 nestjs-cls 自带的 id 生成（generateId），以免引入第二个 id 源，
 * 破坏 ADR-002 中「req.id / pino-http 请求级绑定」的 requestId 权威口径。
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
  ],
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class ContextModule {}
