import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { globalPipes } from './pipes/index';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { PostResponseInterceptor } from './interceptors/post-response.interceptor';
import { UserContextInterceptor } from './interceptors/user-context.interceptor';
import { TimeoutInterceptor } from './interceptors/timeout.interceptor';
import { GlobalExceptionsFilter } from './filters/global-exception.filter';
import cookieParser from 'cookie-parser';
import { RequestContextMiddleware } from './middleware/request-context.middleware';
import { CacheHeaderInterceptor } from './interceptors/cache-header.interceptor';
import { RequestIdMiddleware } from './middleware/request-id.middleware';

// 横切关注点的集中注册点
// 用 @Global() 是因为下面的 APP_* provider 要在整个应用生效；
// 业务 service 仍应通过普通 imports/exports 显式声明依赖。
// @Global()
@Module({
  providers: [
    // 访问日志 / 慢请求 / 状态码分级的职责统一交给 nestjs-pino（pino-http），
    // 这里不再注册自建实现，避免同一条请求产生两套日志。
    // 把 service 写进请求上下文的缓存命中状态，写成 X-Cache 响应头（纯可观测）。
    // 排在 Transform 前/后都行——它只在 tap 里设 header，不改响应体。
    { provide: APP_INTERCEPTOR, useClass: CacheHeaderInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: PostResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: UserContextInterceptor },
    // https://docs.nestjs.cn/techniques/serialization
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    // 全局 ValidationPipe：注意 main.ts 不要再 useGlobalPipes，否则会跑两遍
    {
      provide: APP_PIPE,
      useFactory: globalPipes,
    },
    { provide: APP_FILTER, useClass: GlobalExceptionsFilter },
  ],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // 请求上下文（CLS）必须【最先】挂——它在最外层 .run(store, next) 开上下文，
    // 后续所有中间件 / controller / service / 拦截器都在这个 store 里，X-Cache 状态才传得出去。
    consumer.apply(RequestContextMiddleware).forRoutes('*');

    // 健康探针的自动访问日志由 logger.module.ts 的 autoLogging 统一过滤
    consumer.apply(cookieParser(), RequestIdMiddleware).forRoutes('*');
  }
}
