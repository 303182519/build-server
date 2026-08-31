import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const AuthExceptionCode = {
  INVALID_CREDENTIALS: '10401',
  INVALID_REFRESH_TOKEN: '10403',
  ACCOUNT_LOCKED: '10404',
  // GitHub OAuth：5xx 系列放 105xx，4xx 系列放 104xx，状态类别与 HTTP 一致
  OAUTH_NOT_CONFIGURED: '10501', // 503：服务未配置 GitHub OAuth，跳了也必失败，直接回 503
  OAUTH_EXCHANGE_FAILED: '10502', // 502：打 GitHub 换 token / 拉资料失败（上游故障）
  OAUTH_FAILED: '10405', // 401：用户在 GitHub 授权页点了"拒绝"
  OAUTH_STATE_INVALID: '10406', // 401：state 不存在/已用过/已过期（CSRF 或重复回调）
  OAUTH_TICKET_INVALID: '10407', // 401：ticket 不存在/已用过/已过期（重复兑换或前端太慢）
} as const;

export type AuthExceptionCode =
  (typeof AuthExceptionCode)[keyof typeof AuthExceptionCode];

export const AuthExceptionMap: Record<AuthExceptionCode, ExceptionInfo> = {
  [AuthExceptionCode.INVALID_CREDENTIALS]: {
    message: '用户名或密码错误',
    status: HttpStatus.UNAUTHORIZED,
    code: AuthExceptionCode.INVALID_CREDENTIALS,
  },
  [AuthExceptionCode.INVALID_REFRESH_TOKEN]: {
    message: '无效的刷新令牌',
    status: HttpStatus.UNAUTHORIZED,
    code: AuthExceptionCode.INVALID_REFRESH_TOKEN,
  },
  [AuthExceptionCode.ACCOUNT_LOCKED]: {
    message: '账号因连续登录失败已被临时锁定，请稍后再试',
    status: 423,
    code: AuthExceptionCode.ACCOUNT_LOCKED,
  },
  [AuthExceptionCode.OAUTH_NOT_CONFIGURED]: {
    message: '本服务未配置 GitHub OAuth',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: AuthExceptionCode.OAUTH_NOT_CONFIGURED,
  },
  [AuthExceptionCode.OAUTH_EXCHANGE_FAILED]: {
    message: 'GitHub 授权服务暂不可用，请稍后重试',
    status: HttpStatus.BAD_GATEWAY,
    code: AuthExceptionCode.OAUTH_EXCHANGE_FAILED,
  },
  [AuthExceptionCode.OAUTH_FAILED]: {
    message: 'GitHub 授权被拒绝',
    status: HttpStatus.UNAUTHORIZED,
    code: AuthExceptionCode.OAUTH_FAILED,
  },
  [AuthExceptionCode.OAUTH_STATE_INVALID]: {
    message: 'state 无效或已过期（可能是 CSRF 或重复回调）',
    status: HttpStatus.UNAUTHORIZED,
    code: AuthExceptionCode.OAUTH_STATE_INVALID,
  },
  [AuthExceptionCode.OAUTH_TICKET_INVALID]: {
    message: 'ticket 无效或已过期（可能是重复兑换或兑换超时）',
    status: HttpStatus.UNAUTHORIZED,
    code: AuthExceptionCode.OAUTH_TICKET_INVALID,
  },
};
