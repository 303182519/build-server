import { HttpStatus } from '@nestjs/common';

/**
 * 标准返回体
 */
export interface StandardResponse<T = unknown> {
  code: HttpStatus;
  data: T;
  message: string;
  timestamp: number;
}

export function createResponse<T>(
  data: T,
  code: HttpStatus = HttpStatus.OK,
  message = 'success',
): StandardResponse<T> {
  return {
    code,
    data,
    message,
    timestamp: Date.now(),
  };
}
