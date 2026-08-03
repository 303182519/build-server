import { BaseException, ExceptionInfo } from './base.exception';
import { AuthExceptionCode, AuthExceptionMap } from './auth.exception';
import { UserExceptionCode, UserExceptionMap } from './user.exception';
import { CatExceptionCode, CatExceptionMap } from './cat.exception';

/**
 * 错误码
 * 命名规则：MMSNN 模块代码 + 状态码类别 + 序列号
 * @example INVALID_CREDENTIALS (401): Auth(10) + 4xx(4) + 01 => '10401'
 */
export const ErrorExceptionCode = {
  ...AuthExceptionCode,
  ...UserExceptionCode,
  ...CatExceptionCode,
} as const;

export type ErrorExceptionCode =
  (typeof ErrorExceptionCode)[keyof typeof ErrorExceptionCode];

export const ErrorExceptionMap: Record<ErrorExceptionCode, ExceptionInfo> = {
  ...AuthExceptionMap,
  ...UserExceptionMap,
  ...CatExceptionMap,
};

export class ErrorException extends BaseException {
  constructor(errorCode: ErrorExceptionCode) {
    const exception = ErrorExceptionMap[errorCode];
    super(exception);
  }
}
