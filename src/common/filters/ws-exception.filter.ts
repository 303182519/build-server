import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { BaseException } from '@/common/exceptions/base.exception';

export interface WsErrorResponse {
  status: number;
  message: string;
  code?: string;
}

/**
 * 将任意异常还原为标准化的 { status, message, code? } 响应体。
 * WsExceptionFilter 与 SocketGateway（handleConnection 鉴权失败路径）共用，
 * 保证 WS 错误响应 wire format 单一事实源。
 *
 * 响应体统一为 `{ status, message, code? }`，status 始终为数字，
 * 兼容前端 `error.status === 401` 的分支判断。
 */
export function toWsErrorResponse(exception: unknown): WsErrorResponse {
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

  // 3) HTTP 异常（含 @nestjs/throttler 抛出的 ThrottlerException=429），
  //    透传其状态码与消息，避免被统一兜底为 500。
  if (exception instanceof HttpException) {
    const res = exception.getResponse();
    const message =
      typeof res === 'string'
        ? res
        : Array.isArray((res as { message?: unknown }).message)
          ? (res as { message: string[] }).message.join(', ')
          : (res as { message?: string }).message ||
            exception.message ||
            '请求处理失败';
    return { status: exception.getStatus(), message };
  }

  // 4) 未预期异常：不向客户端泄露内部错误详情，统一返回 500
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: '服务器繁忙，请稍后重试',
  };
}

/**
 * WebSocket 全局异常过滤器。
 * 捕获 WS 消息管道中的所有异常（guard / interceptor / handler），
 * 统一错误通道：
 * - 客户端 emit 携带 ack 回调（emitWithAck）时，错误通过 ack 返回，
 *   避免 emitWithAck 在参数校验失败 / 限流等异常场景下永久悬挂；
 * - 未携带 ack 时，通过 `exception` 事件下发。
 * 两条路径互斥，每条消息只有一条错误返回通路，且响应体结构一致。
 */
@Catch()
export class WsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const response = toWsErrorResponse(exception);

    // 4xx 客户端问题（鉴权失败、参数错误等）记 warn，不混入 5xx 告警；
    // 5xx 服务端故障记 error，并保留原始异常对象供排障。
    if (response.status >= 500) {
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

    // Socket.IO 消息的 args 结构为 [client, data, ack?]，
    // 仅当客户端显式携带 ack 回调时第三个参数才存在。
    const ack: unknown = host.getArgByIndex(2);
    if (typeof ack === 'function') {
      (ack as (payload: { success: boolean } & WsErrorResponse) => void)({
        success: false,
        ...response,
      });
      return;
    }

    client.emit('exception', response);
  }
}
