import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { createResponse } from '../response/base.response';
import { Request, Response } from 'express';
/**
 * 响应包装拦截器
 * 将所有成功响应包装为统一格式: { code, data, message }
 * 错误路径不会经过 Interceptor 的 after 钩子，所以错误响应的统一格式由 GlobalExceptionsFilter 负责。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const routePath = (request.route as { path?: string } | undefined)?.path;

    // Health responses have their own contract; keep them unwrapped.
    if (
      request.method === 'GET' &&
      (routePath === '/health' || routePath === '/health/ready')
    ) {
      return next.handle() as Observable<unknown>;
    }

    // 如果开发者手动使用 @Res() 原生响应，跳过拦截器封装，防止冲突
    if (response.headersSent) {
      return next.handle() as Observable<{
        code: number;
        data: unknown;
        message: string;
      }>;
    }

    return next.handle().pipe(
      map((data) => {
        // 已是标准格式则透传，避免重复包装
        // 注意：必须同时校验 code 为 number、message 为 string，
        // 否则像 Permission 这种实体（自带 string 类型的 code 字段）会被误判
        if (
          data &&
          typeof data === 'object' &&
          typeof (data as Record<string, unknown>).code === 'number' &&
          typeof (data as Record<string, unknown>).message === 'string'
        ) {
          return data;
        }
        return createResponse(data, response.statusCode);
      }),
    );
  }
}
