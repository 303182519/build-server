import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { IsProduction } from '../constants/environment';
import { BaseException } from '../exceptions/base.exception';

/**
 * TODO: 日志系统代办
 * 将日志系统与异常过滤器结合，将异常信息记录到日志系统中
 * 制作成接口，以便在 UI 中展示
 * 接口权限控制仅限 developer Role 使用
 */

/**
 * 全局异常过滤器
 * 处理所有未捕获的异常，并将其转换为统一的响应格式
 */
@Catch()
export class GlobalExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const responseBody = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      msg: '服务器繁忙，请稍后重试',
      code: 'INTERNAL_SERVER_ERROR',
      timestamp: new Date().toISOString(),
    };

    if (exception instanceof BaseException) {
      // 处理自定义异常
      const exceptionResponse = exception.getResponse() as {
        message: string;
        code: string;
      };

      responseBody.statusCode = exception.getStatus();
      responseBody.msg = exceptionResponse.message;
      responseBody.code = exceptionResponse.code || exception.name;
    } else if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      responseBody.statusCode = exception.getStatus();

      if (typeof exceptionResponse === 'object') {
        const exceptionObj = exceptionResponse as {
          message: string | string[];
          error: string;
        };
        // 管道校验异常（class-validator）会返回 message 数组
        // console.log('管道校验异常', resObj);
        responseBody.msg = Array.isArray(exceptionObj.message)
          ? exceptionObj.message.join(', ')
          : exceptionObj.message;
        responseBody.code = exceptionObj.error;
      } else {
        responseBody.msg = exceptionResponse;
        responseBody.code = exception.name;
      }
    } else if (exception instanceof Error) {
      if (!IsProduction) {
        responseBody.msg = exception.message;
      }
      responseBody.code = exception.name;
    }

    // 记录错误日志
    this.logger.error(
      `[${request.method}] ${request.url} ${responseBody.statusCode} Code: ${responseBody.code} Message: ${responseBody.msg}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(responseBody.statusCode).json(responseBody);
  }
}
