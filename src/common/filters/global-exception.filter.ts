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
import { StandardResponse } from '../response/base.response';

/**
 * TODO: 日志系统代办
 * 将日志系统与异常过滤器结合，将异常信息记录到日志系统中
 * 制作成接口，以便在 UI 中展示
 * 接口权限控制仅限 developer Role 使用
 */

/** 匹配 JSON 解析错误信息（V8 的 JSON.parse 抛出的 SyntaxError 文案） */
const JSON_PARSE_ERROR_REGEX = /in JSON at position|end of JSON input/i;

/**
 * 判断异常是否为请求体 JSON 解析错误
 *
 * body-parser 解析失败时抛出的异常可能是以下几种形态：
 * 1. http-errors 的 BadRequest（带 type: 'entity.parse.failed'）
 * 2. 被 NestJS 包装后的 HttpException（response.message 含解析错误信息）
 * 3. 原生 SyntaxError（message 含 "in JSON at position" 等）
 */
function isJsonParseError(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;

  // body-parser 标识
  if ((exception as { type?: string }).type === 'entity.parse.failed') {
    return true;
  }

  // 检查异常自身的 message（覆盖原生 SyntaxError / http-errors）
  if (JSON_PARSE_ERROR_REGEX.test(exception.message)) {
    return true;
  }

  // 检查 HttpException 包装后的 response.message
  if (exception instanceof HttpException) {
    const exceptionResponse = exception.getResponse();
    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const msg = (exceptionResponse as { message?: unknown }).message;
      if (typeof msg === 'string' && JSON_PARSE_ERROR_REGEX.test(msg)) {
        return true;
      }
      if (
        Array.isArray(msg) &&
        msg.some((m) => typeof m === 'string' && JSON_PARSE_ERROR_REGEX.test(m))
      ) {
        return true;
      }
    }
  }

  return false;
}

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

    const responseBody: StandardResponse<null> = {
      code: HttpStatus.INTERNAL_SERVER_ERROR,
      data: null,
      message: '服务器繁忙，请稍后重试',
    };

    // 请求体 JSON 语法错误：返回友好提示，避免把 V8 解析细节（如 "Expected ... in JSON at position N"）直接暴露给客户端
    if (isJsonParseError(exception)) {
      responseBody.code = HttpStatus.BAD_REQUEST;
      responseBody.message = '请求JSON格式错误，请检查请求体语法';
    } else if (exception instanceof BaseException) {
      const exceptionResponse = exception.getResponse() as {
        message: string;
        code: string;
      };

      responseBody.code = exception.getStatus();
      responseBody.message = exceptionResponse.message;
    } else if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      responseBody.code = exception.getStatus();
      if (typeof exceptionResponse === 'object') {
        const exceptionObj = exceptionResponse as {
          message?: string;
          error?: string;
          data?: unknown;
        };
        // 优先使用自定义异常中传入的 data（如校验错误的 field+message 数组）
        if (exceptionObj.data !== undefined) {
          (responseBody as StandardResponse<unknown>).data = exceptionObj.data;
        }
        // 管道校验异常（class-validator）会返回 message 数组
        if (exceptionObj.message !== undefined) {
          responseBody.message = exceptionObj.message;
        }
      } else {
        responseBody.message = exceptionResponse;
      }
    } else if (exception instanceof Error) {
      if (!IsProduction) {
        responseBody.message = exception.message;
      }
    }

    // 记录错误日志
    this.logger.error(
      `[${request.method}] ${request.url} ${responseBody.code} Message: ${responseBody.message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(responseBody.code).json(responseBody);
  }
}
