import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const AgentExceptionCode = {
  AGENT_NOT_CONFIGURED: '17501',
  RUN_NOT_FOUND: '17401',
  RUN_NOT_PENDING: '17402',
  RUN_NOT_OWNER: '17403',
  SSE_CONNECTIONS_EXCEEDED: '17503',
  GRAPH_INTERRUPT_FAILED: '17502',
} as const;

export type AgentExceptionCode =
  (typeof AgentExceptionCode)[keyof typeof AgentExceptionCode];

export const AgentExceptionMap: Record<AgentExceptionCode, ExceptionInfo> = {
  [AgentExceptionCode.AGENT_NOT_CONFIGURED]: {
    message: 'Agent 模块未配置 QianWen API，请联系管理员',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: AgentExceptionCode.AGENT_NOT_CONFIGURED,
  },
  [AgentExceptionCode.RUN_NOT_FOUND]: {
    message: 'Agent 运行不存在',
    status: HttpStatus.NOT_FOUND,
    code: AgentExceptionCode.RUN_NOT_FOUND,
  },
  [AgentExceptionCode.RUN_NOT_PENDING]: {
    message: '当前运行不可审批（非 PENDING 状态或已超时）',
    status: HttpStatus.CONFLICT,
    code: AgentExceptionCode.RUN_NOT_PENDING,
  },
  [AgentExceptionCode.RUN_NOT_OWNER]: {
    message: '无权操作该 Agent 运行',
    status: HttpStatus.FORBIDDEN,
    code: AgentExceptionCode.RUN_NOT_OWNER,
  },
  [AgentExceptionCode.SSE_CONNECTIONS_EXCEEDED]: {
    message: 'SSE 连接数已达上限，请稍后重试',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: AgentExceptionCode.SSE_CONNECTIONS_EXCEEDED,
  },
  [AgentExceptionCode.GRAPH_INTERRUPT_FAILED]: {
    message: 'Agent 恢复执行失败',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: AgentExceptionCode.GRAPH_INTERRUPT_FAILED,
  },
};
