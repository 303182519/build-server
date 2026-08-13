import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
	ClassSerializerInterceptor,
} from '@nestjs/common';
import { globalPipes } from './pipes/index';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TimingInterceptor } from './interceptors/timing.interceptor';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { PostResponseInterceptor } from './interceptors/post-response.interceptor';
import { UserContextInterceptor } from './interceptors/user-context.interceptor';
import { TimeoutInterceptor } from './interceptors/timeout.interceptor';
import { GlobalExceptionsFilter } from './filters/global-exception.filter';
import cookieParser from 'cookie-parser';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { HttpLoggerMiddleware } from './middleware/http-logger.middleware';



// 横切关注点的集中注册点
// 用 @Global() 是因为下面的 APP_* provider 要在整个应用生效；
// 业务 service 仍应通过普通 imports/exports 显式声明依赖。
// @Global()
@Module({
  providers: [
    // 注册顺序就是执行顺序：Timing 在最外层，能测到全链路耗时
    // 写反（Timing 在内层）会让统计值偏小
    { provide: APP_INTERCEPTOR, useClass: TimingInterceptor },
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
    consumer
      .apply(cookieParser(), RequestIdMiddleware, HttpLoggerMiddleware)
      // /health 不进访问日志：会被探针高频调用，日志量没价值
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}