import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const RoleExceptionCode = {
  ROLE_NOT_FOUND: '15401',
  // 403 Forbidden：系统内置角色不可删除（误删会锁死系统）
  ROLE_IS_SYSTEM: '15403',
  // 409 Conflict：code 唯一约束冲突
  ROLE_CODE_EXISTS: '15409',
  // 409 Conflict：角色仍被用户持有，删除会引发未授权的权限收回
  ROLE_IN_USE: '15410',
} as const;

export type RoleExceptionCode =
  (typeof RoleExceptionCode)[keyof typeof RoleExceptionCode];

export const RoleExceptionMap: Record<RoleExceptionCode, ExceptionInfo> = {
  [RoleExceptionCode.ROLE_NOT_FOUND]: {
    message: 'Role not found',
    status: HttpStatus.NOT_FOUND,
    code: RoleExceptionCode.ROLE_NOT_FOUND,
  },
  [RoleExceptionCode.ROLE_IS_SYSTEM]: {
    message: 'System role cannot be modified',
    status: HttpStatus.FORBIDDEN,
    code: RoleExceptionCode.ROLE_IS_SYSTEM,
  },
  [RoleExceptionCode.ROLE_CODE_EXISTS]: {
    message: 'Role code already exists',
    status: HttpStatus.CONFLICT,
    code: RoleExceptionCode.ROLE_CODE_EXISTS,
  },
  [RoleExceptionCode.ROLE_IN_USE]: {
    message: 'Role is still assigned to users',
    status: HttpStatus.CONFLICT,
    code: RoleExceptionCode.ROLE_IN_USE,
  },
};
