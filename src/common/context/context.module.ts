import { Global, Module } from '@nestjs/common';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestContextService } from './request-context.service';
import { resolveRequestId } from '../request-id';
import { PrismaModule } from '@/shared/database/prisma/prisma.module';
import { PrismaService } from '@/shared/database/prisma/prisma.service';

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
 * Prisma 事务插件（ADR-006）：`ClsPluginTransactional` 把「当前事务」存进 CLS，
 * 业务代码注入 `TransactionHost<TransactionalAdapterPrisma<PrismaService>>` 后，
 * 用 `withTransaction(fn)` 开事务、`txHost.tx` 取当前事务客户端（无事务时回退为基座
 * PrismaService）。事务上下文随 CLS 跨 Provider 传播，不再需要手工透传 tx 参数。
 * `sqlFlavor: 'mysql'` 声明存储点语法，为嵌套事务（Propagation.RequiresNew）提供支持。
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
      plugins: [
        // 显式 imports PrismaModule：插件内部模块需要解析 PrismaService 注入令牌。
        // PrismaModule 本身是 @Global，这里再 import 一次是幂等的（Nest 按模块类去重）。
        new ClsPluginTransactional({
          imports: [PrismaModule],
          adapter: new TransactionalAdapterPrisma<PrismaService>({
            prismaInjectionToken: PrismaService,
            sqlFlavor: 'mysql',
          }),
        }),
      ],
    }),
  ],
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class ContextModule {}
