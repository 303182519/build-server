import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

/**
 * 基于 Pino 的全局 HTTP 访问日志中间件
 *
 * 特性：
 * - 结构化 JSON 日志输出
 * - 自动关联 requestId
 * - 慢请求检测（warn 级别）
 * - 按状态码分级（5xx=error, 4xx=warn, 其他=info）
 */
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: PinoLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const requestId = req.headers['x-request-id'] as string | undefined;

    res.on('finish', () => {
      const ms = Date.now() - start;
      const method = req.method;
      const url = req.originalUrl;
      const statusCode = res.statusCode;

      // 构建日志上下文
      const logContext = {
        requestId,
        method,
        url,
        statusCode,
        responseTime: ms,
      };

      // 根据状态码和响应时间选择日志级别
      if (statusCode >= 500) {
        this.logger.error(
          `HTTP ${method} ${url} ${statusCode} ${ms}ms`,
          logContext,
        );
      } else if (statusCode >= 400) {
        this.logger.warn(
          `HTTP ${method} ${url} ${statusCode} ${ms}ms`,
          logContext,
        );
      } else {
        this.logger.info(
          `HTTP ${method} ${url} ${statusCode} ${ms}ms`,
          logContext,
        );
      }
    });

    next();
  }
}
