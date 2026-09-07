import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const StorageExceptionCode = {
  INVALID_FILE: '16422',
  UPLOAD_TOO_LARGE: '16413',
  UNSUPPORTED_MEDIA_TYPE: '16415',
  STORAGE_FAILED: '16502',
  TOO_MANY_UPLOADS: '16503',
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
    [StorageExceptionCode.UPLOAD_TOO_LARGE]: {
      message: '上传文件超过大小限制',
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: StorageExceptionCode.UPLOAD_TOO_LARGE,
    },
    [StorageExceptionCode.UNSUPPORTED_MEDIA_TYPE]: {
      message: '仅支持 jpeg/png/webp/gif/avif 格式的图片',
      status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      code: StorageExceptionCode.UNSUPPORTED_MEDIA_TYPE,
    },
    [StorageExceptionCode.STORAGE_FAILED]: {
      message: '文件存储失败，请稍后重试',
      status: HttpStatus.BAD_GATEWAY,
      code: StorageExceptionCode.STORAGE_FAILED,
    },
    [StorageExceptionCode.TOO_MANY_UPLOADS]: {
      message: '当前上传请求过多，请稍后重试',
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: StorageExceptionCode.TOO_MANY_UPLOADS,
    },
  };
