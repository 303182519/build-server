import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const PermissionExceptionCode = {
  PERMISSION_NOT_FOUND: '14401',
  PERMISSION_NAME_ALREADY_EXISTS: '14402',
  PERMISSION_CODE_ALREADY_EXISTS: '14403',
} as const;

export type PermissionExceptionCode =
  (typeof PermissionExceptionCode)[keyof typeof PermissionExceptionCode];

export const PermissionExceptionMap: Record<
  PermissionExceptionCode,
  ExceptionInfo
> = {
  [PermissionExceptionCode.PERMISSION_NOT_FOUND]: {
    message: 'Permission not found',
    status: HttpStatus.NOT_FOUND,
    code: PermissionExceptionCode.PERMISSION_NOT_FOUND,
  },
  [PermissionExceptionCode.PERMISSION_NAME_ALREADY_EXISTS]: {
    message: '权限名称已存在',
    status: HttpStatus.CONFLICT,
    code: PermissionExceptionCode.PERMISSION_NAME_ALREADY_EXISTS,
  },
  [PermissionExceptionCode.PERMISSION_CODE_ALREADY_EXISTS]: {
    message: '权限编码已存在',
    status: HttpStatus.CONFLICT,
    code: PermissionExceptionCode.PERMISSION_CODE_ALREADY_EXISTS,
  },
};
