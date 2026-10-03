import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { BaseException } from '@/common/exceptions/base.exception';

interface WsErrorResponse {
  status: number;
  message: string;
  code?: string;
}

/**
 * WebSocket 全局异常过滤器。
 * 捕获 WS 消息管道中的所有异常（guard / interceptor / handler），
 * 统一通过 `exception` 事件下发给客户端，避免未捕获异常导致连接异常断开。
 *
 * 响应体统一为 `{ status, message, code? }`，status 始终为数字，
 * 兼容前端 `error.status === 401` 的分支判断。
 */
@Catch()
export class WsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const response = this.toResponse(exception);

    // 4xx 客户端问题（鉴权失败、参数错误等）记 warn，不混入 5xx 告警；
    // 5xx 服务端故障记 error，并保留原始异常对象供排障。
    if (response.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error('WebSocket exception', {
        category: 'Socket',
        context: { socketId: client.id, response },
        ...(exception instanceof Error ? { err: exception } : {}),
      });
    } else {
      this.logger.warn('WebSocket exception', {
        category: 'Socket',
        context: { socketId: client.id, response },
      });
    }

    client.emit('exception', response);
  }

  private toResponse(exception: unknown): WsErrorResponse {
    // 1) 显式抛出的 WsException（guard 鉴权失败等）
    if (exception instanceof WsException) {
      const error = exception.getError();
      if (typeof error === 'string') {
        // 字符串型 WsException 统一按 400 客户端错误处理，
        // status 用数字避免破坏前端 error.status === 401 判断。
        return { status: HttpStatus.BAD_REQUEST, message: error };
      }
      const obj = error as {
        status?: unknown;
        message?: unknown;
        code?: string;
      };
      const status =
        typeof obj.status === 'number' ? obj.status : HttpStatus.BAD_REQUEST;
      const message =
        typeof obj.message === 'string' ? obj.message : '请求处理失败';
      return {
        status,
        message,
        ...(obj.code ? { code: obj.code } : {}),
      };
    }

    // 2) 业务异常（ErrorException 等），从 ExceptionMap 取 message/code/status
    if (exception instanceof BaseException) {
      const info = exception.getResponse() as {
        message: string | string[];
        code?: string;
      };
      return {
        status: exception.getStatus(),
        message: Array.isArray(info.message)
          ? info.message.join(', ')
          : info.message,
        ...(info.code ? { code: info.code } : {}),
      };
    }

    // 3) 未预期异常：不向客户端泄露内部错误详情，统一返回 500
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: '服务器繁忙，请稍后重试',
    };
  }
}
