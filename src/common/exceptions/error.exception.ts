import { BaseException, ExceptionInfo } from './base.exception';
import { AuthExceptionCode, AuthExceptionMap } from './auth.exception';
import { UserExceptionCode, UserExceptionMap } from './user.exception';
import { PostExceptionCode, PostExceptionMap } from './post.exception';
import {
  PermissionExceptionCode,
  PermissionExceptionMap,
} from './permission.exception';
/**
 * 错误码
 * 命名规则：MMSNN 模块代码 + 状态码类别 + 序列号
 * @example INVALID_CREDENTIALS (401): Auth(10) + 4xx(4) + 01 => '10401'
 */
export const ErrorExceptionCode = {
  ...AuthExceptionCode,
  ...UserExceptionCode,
  ...PostExceptionCode,
  ...PermissionExceptionCode,
} as const;

export type ErrorExceptionCode =
  (typeof ErrorExceptionCode)[keyof typeof ErrorExceptionCode];

export const ErrorExceptionMap: Record<ErrorExceptionCode, ExceptionInfo> = {
  ...AuthExceptionMap,
  ...UserExceptionMap,
  ...PostExceptionMap,
  ...PermissionExceptionMap,
};

export class ErrorException extends BaseException {
  constructor(errorCode: ErrorExceptionCode) {
    const exception = ErrorExceptionMap[errorCode];
    super(exception);
  }
}
