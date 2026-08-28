import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const AuthExceptionCode = {
  INVALID_CREDENTIALS: '10401',
  INVALID_REFRESH_TOKEN: '10403',
  ACCOUNT_LOCKED: '10404',
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
};
