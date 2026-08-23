import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const UserExceptionCode = {
  USER_NOT_FOUND: '11401',
  USER_ALREADY_EXISTS: '11402',
  NEW_PASSWORD_SAME_AS_OLD: '11403',
  SUPER_ADMIN_IS_SPECIAL: '11404',
  CANNOT_DELETE_SELF: '11405',
  USERNAME_ALREADY_EXISTS: '11406',
  EMAIL_ALREADY_EXISTS: '11407',
  UPDATE_PERMISSION_DENIED: '11408',
} as const;

export type UserExceptionCode =
  (typeof UserExceptionCode)[keyof typeof UserExceptionCode];

export const UserExceptionMap: Record<UserExceptionCode, ExceptionInfo> = {
  [UserExceptionCode.USER_NOT_FOUND]: {
    message: '用户不存在',
    status: HttpStatus.NOT_FOUND,
    code: UserExceptionCode.USER_NOT_FOUND,
  },
  [UserExceptionCode.USER_ALREADY_EXISTS]: {
    message: '用户名或邮箱已存在',
    status: HttpStatus.CONFLICT,
    code: UserExceptionCode.USER_ALREADY_EXISTS,
  },
  [UserExceptionCode.NEW_PASSWORD_SAME_AS_OLD]: {
    message: '新密码与旧密码相同',
    status: HttpStatus.BAD_REQUEST,
    code: UserExceptionCode.NEW_PASSWORD_SAME_AS_OLD,
  },
  [UserExceptionCode.SUPER_ADMIN_IS_SPECIAL]: {
    message: '超级管理员十分特殊喔',
    status: HttpStatus.BAD_REQUEST,
    code: UserExceptionCode.SUPER_ADMIN_IS_SPECIAL,
  },
  [UserExceptionCode.CANNOT_DELETE_SELF]: {
    message: '不能删除当前登录用户',
    status: HttpStatus.BAD_REQUEST,
    code: UserExceptionCode.CANNOT_DELETE_SELF,
  },
  [UserExceptionCode.USERNAME_ALREADY_EXISTS]: {
    message: '用户名已存在',
    status: HttpStatus.CONFLICT,
    code: UserExceptionCode.USERNAME_ALREADY_EXISTS,
  },
  [UserExceptionCode.EMAIL_ALREADY_EXISTS]: {
    message: '邮箱已存在',
    status: HttpStatus.CONFLICT,
    code: UserExceptionCode.EMAIL_ALREADY_EXISTS,
  },
  [UserExceptionCode.UPDATE_PERMISSION_DENIED]: {
    message: '无权限修改该用户信息',
    status: HttpStatus.FORBIDDEN,
    code: UserExceptionCode.UPDATE_PERMISSION_DENIED,
  },
};
