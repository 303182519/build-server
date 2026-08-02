import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { createResponse } from '../dto/response.dto';
import { Response } from 'express';
/**
 * 响应包装拦截器
 * 将所有成功响应包装为统一格式: { code, data, message, timestamp }
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<any> {
    const httpContext = context.switchToHttp();
    const response = httpContext.getResponse<Response>();

    // 如果开发者手动使用 @Res() 原生响应，跳过拦截器封装，防止冲突
    if (response.headersSent) {
      return next.handle() as Observable<{
        code: number;
        data: unknown;
        msg: string;
        timestamp: number;
      }>;
    }

    return next.handle().pipe(
      map((data) => {
        // 已是标准格式则透传，避免重复包装
        if (
          data &&
          typeof data === 'object' &&
          'code' in data &&
          'timestamp' in data
        ) {
          return data;
        }
        return createResponse(response.statusCode, data);
      }),
    );
  }
}
