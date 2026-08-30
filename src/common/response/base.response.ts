import { HttpStatus } from '@nestjs/common';

/**
 * 通用业务状态码
 * 仅作为全局异常过滤器在"拿不到业务错误码"时的兜底值；
 * 业务异常应通过 ErrorException 携带各自的业务错误码（MMSNN 规范）。
 * 分段规则：A = 用户端/请求错误，B = 系统内部错误，C = 第三方服务错误
 */
export const BizCode = {
  /** 用户端通用错误（4xx 兜底） */
  CLIENT_ERROR: 'A0001',
  /** 请求体 JSON 语法错误 */
  BAD_REQUEST: 'A0400',
  /** 系统内部错误（5xx 兜底） */
  INTERNAL_ERROR: 'B0001',
} as const;

export type BizCode = (typeof BizCode)[keyof typeof BizCode];

/**
 * 标准返回体
 *
 * 字段分层设计：
 * - HTTP 状态行：传输层，供网关 / 监控 / 重试策略使用
 * - code：HTTP 状态码，与状态行保持一致，用于粗分类（2xx 成功 / 4xx 调用方问题 / 5xx 服务端问题）
 * - bizCode：业务状态码，仅失败时出现，用于精确定位业务错误（如 token 过期跳登录）
 *
 * 成功与失败共用同一 envelope，前端判断 res.code === 200 即可，bizCode 仅在失败分支读取
 */
export interface StandardResponse<T = unknown> {
  code: HttpStatus;
  message: string;
  /** 业务数据：成功时为业务数据，失败时恒为 null，保持结构稳定 */
  data: T | null;
  /** 业务状态码，仅失败时出现 */
  bizCode?: string;
  /** 字段级校验错误（如 表单校验的 field+message 数组），仅失败时出现 */
  errors?: unknown;
  /** 请求路径，仅失败时出现 */
  path?: string;
  /** 链路 ID（取自 X-Request-Id），仅失败时出现，用于日志关联 */
  requestId?: string;
}

export function createResponse<T>(
  data: T,
  code: HttpStatus = HttpStatus.OK,
  message = 'success',
): StandardResponse<T> {
  return {
    code,
    data,
    message,
  };
}
