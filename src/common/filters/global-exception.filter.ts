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
import { BizCode, StandardResponse } from '../response/base.response';

/**
 * TODO: 日志系统代办
 * 将日志系统与异常过滤器结合，将异常信息记录到日志系统中
 * 制作成接口，以便在 UI 中展示
 * 接口权限控制仅限 developer Role 使用
 */

/**
 * 匹配 JSON 解析错误信息
 * 覆盖多种 V8 / body-parser 可能抛出的 SyntaxError 文案格式：
 * 1. 老版本："Unexpected token x in JSON at position N"
 * 2. 新版本："Unexpected token 'x', ... is not valid JSON"
 * 3. 输入不完整："Unexpected end of JSON input"
 * 4. 期望字符："Expected ':' after property name in JSON at position N"
 */
const JSON_PARSE_ERROR_REGEX =
  /in JSON at position|end of JSON input|is not valid JSON|Unexpected token/i;

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
 * 无业务错误码可提供时，按 HTTP 状态归类兜底 bizCode
 * 避免将 exception.name（如 TypeError）等实现细节透出给客户端
 */
function fallbackBizCode(status: HttpStatus): string {
  return status >= HttpStatus.INTERNAL_SERVER_ERROR
    ? BizCode.INTERNAL_ERROR
    : BizCode.CLIENT_ERROR;
}

/**
 * 从 X-Request-Id 请求头中提取链路 ID
 * RequestIdMiddleware 保证每个请求都会携带该头（上游未带时自动生成）
 */
function resolveRequestId(headers: Request['headers']): string | undefined {
  const value = headers['x-request-id'];
  return Array.isArray(value) ? value[0] : value;
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
      message: '服务器繁忙，请稍后重试',
      data: null,
      bizCode: BizCode.INTERNAL_ERROR,
      path: request.url,
      requestId: resolveRequestId(request.headers),
    };

    // 请求体 JSON 语法错误：返回友好提示，避免把 V8 解析细节（如 "Expected ... in JSON at position N"）直接暴露给客户端
    if (isJsonParseError(exception)) {
      responseBody.code = HttpStatus.BAD_REQUEST;
      responseBody.message = '请求JSON格式错误，请检查请求体语法';
      responseBody.bizCode = BizCode.BAD_REQUEST;
    } else if (exception instanceof BaseException) {
      const exceptionResponse = exception.getResponse() as {
        message: string | string[];
        code?: string;
      };

      responseBody.code = exception.getStatus();
      responseBody.message = Array.isArray(exceptionResponse.message)
        ? exceptionResponse.message.join(', ')
        : exceptionResponse.message;
      // 业务异常应携带业务错误码（MMSNN 规范），未携带时按 HTTP 状态归类兜底
      responseBody.bizCode =
        exceptionResponse.code || fallbackBizCode(responseBody.code);
    } else if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      responseBody.code = exception.getStatus();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const exceptionObj = exceptionResponse as {
          message?: string | string[];
          code?: string;
          errors?: unknown;
        };
        // 优先使用自定义异常中传入的 data（如校验错误的 field+message 数组）
        if (exceptionObj.errors !== undefined) {
          responseBody.errors = exceptionObj.errors;
        }
        if (exceptionObj.message !== undefined) {
          responseBody.message = Array.isArray(exceptionObj.message)
            ? exceptionObj.message.join(', ')
            : exceptionObj.message;
        }
        responseBody.bizCode =
          exceptionObj.code || fallbackBizCode(responseBody.code);
      } else {
        responseBody.bizCode = fallbackBizCode(responseBody.code);
      }
    } else if (exception instanceof Error) {
      if (!IsProduction) {
        responseBody.message = exception.message;
      }
      responseBody.bizCode = BizCode.INTERNAL_ERROR;
    }

    // 记录错误日志
    this.logger.error(
      `[${request.method}] ${request.url} ${responseBody.code} bizCode=${responseBody.bizCode} reqId=${responseBody.requestId} Message: ${responseBody.message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(responseBody.code).json(responseBody);
  }
}
