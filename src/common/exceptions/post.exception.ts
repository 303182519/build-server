import { HttpStatus } from '@nestjs/common';
import { ExceptionInfo } from './base.exception';

export const PostExceptionCode = {
  POST_NOT_FOUND: '13401',
  SLUG_TAKEN: '13402',
  POST_ARCHIVED: '13403',
  INVALID_CURSOR: '13404',
} as const;

export type PostExceptionCode =
  (typeof PostExceptionCode)[keyof typeof PostExceptionCode];

export const PostExceptionMap: Record<PostExceptionCode, ExceptionInfo> = {
  [PostExceptionCode.POST_NOT_FOUND]: {
    message: 'Post not found',
    status: HttpStatus.NOT_FOUND,
    code: PostExceptionCode.POST_NOT_FOUND,
  },
  [PostExceptionCode.SLUG_TAKEN]: {
    message: 'slug 已被占用',
    status: HttpStatus.CONFLICT,
    code: PostExceptionCode.SLUG_TAKEN,
  },
  [PostExceptionCode.POST_ARCHIVED]: {
    message: 'Post 已归档，不能再修改',
    status: HttpStatus.CONFLICT,
    code: PostExceptionCode.POST_ARCHIVED,
  },
  [PostExceptionCode.INVALID_CURSOR]: {
    message: 'cursor 参数非法',
    status: HttpStatus.BAD_REQUEST,
    code: PostExceptionCode.INVALID_CURSOR,
  },
};
