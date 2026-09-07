import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const StorageExceptionCode = {
  INVALID_FILE: '16422',
} as const;

export type StorageExceptionCode =
  (typeof StorageExceptionCode)[keyof typeof StorageExceptionCode];

export const StorageExceptionMap: Record<StorageExceptionCode, ExceptionInfo> =
  {
    [StorageExceptionCode.INVALID_FILE]: {
      message: '文件不是合法的图片，或已损坏',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: StorageExceptionCode.INVALID_FILE,
    },
  };
