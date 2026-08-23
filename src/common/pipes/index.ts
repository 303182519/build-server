import { ValidationPipe, BadRequestException } from '@nestjs/common';

import type { ValidationError } from 'class-validator';

interface FieldError {
  field: string;
  messages: string[];
}

// 去掉消息开头重复的字段名前缀："username 长度必须在..." → "长度必须在..."
function stripFieldPrefix(messages: string[], property: string): string[] {
  const prefix = `${property} `;
  return messages.map((msg) =>
    msg.startsWith(prefix) ? msg.slice(prefix.length) : msg,
  );
}

// 把嵌套 DTO 的校验错误压平：errors[i].children[j].constraints → { field: 'a.b', messages: [...] }
function flattenErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldError[] {
  return errors.flatMap((err) => {
    const path = parentPath ? `${parentPath}.${err.property}` : err.property;
    const own: FieldError[] = err.constraints
      ? [
          {
            field: path,
            messages: stripFieldPrefix(
              Object.values(err.constraints),
              err.property,
            ),
          },
        ]
      : [];
    const children = err.children?.length
      ? flattenErrors(err.children, path)
      : [];
    return [...own, ...children];
  });
}

export const globalPipes = () => {
  return new ValidationPipe({
    // 过滤掉 DTO 中未声明的字段（前端额外传垃圾字段直接剔除）安全必备
    whitelist: true,
    // 如果前端传递了白名单以外的字段，直接抛出异常（严格模式）
    forbidNonWhitelisted: true,
    // 自动把普通JSON对象转为DTO类实例 + 自动类型转换（string→number等）
    transform: true,
    // query/param 的 string 自动转 number/boolean
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: '请求参数校验失败',
        errors: flattenErrors(errors),
      }),
  });
};
