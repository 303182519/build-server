/**
 * 标准返回体
 */
export interface StandardResponse<T = any> {
  code: number;
  data: T;
  message: string;
  timestamp: number;
}

export function createResponse<T>(
  code: number,
  data: T,
  message = 'success',
): StandardResponse<T> {
  return {
    code,
    data,
    message,
    timestamp: Date.now(),
  };
}
