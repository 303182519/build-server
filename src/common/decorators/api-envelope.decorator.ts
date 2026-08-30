import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ExceptionInfo } from '@/common/exceptions/base.exception';

// ============================================================================
// 文档化"统一响应外壳"
// ----------------------------------------------------------------------------
// 难点：TransformInterceptor 把每个成功返回都包成
//   { code:0, data, message:"ok", requestId, timestamp }
// 所以 Controller 方法的**真实返回类型**和**实际 JSON**不一致——Swagger 默认按返回
// 类型推断会少了这层外壳。这两个装饰器用 $ref 把"外壳 + 具体 data 模型"拼起来，
// 让 /docs 显示真实结构。这就是把 Day 19 的响应规范"如实写进文档"。
// ============================================================================

// 成功响应：data 是 model（或 model 数组）
export function ApiEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: { isArray?: boolean; status?: number; description?: string } = {},
) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description,
      schema: {
        properties: {
          code: { type: 'number', example: 0 },
          data: options.isArray
            ? { type: 'array', items: { $ref: getSchemaPath(model) } }
            : { $ref: getSchemaPath(model) },
          message: { type: 'string', example: 'success' },
        },
      },
    }),
  );
}

// 失败响应：与 GlobalExceptionsFilter 的实际输出结构一致 { statusCode, code, message }
export function ApiErrorEnvelope(
  status: number,
  description: string,
  codeExample: string,
) {
  return ApiResponse({
    status,
    description,
    schema: {
      properties: {
        statusCode: { type: 'number', example: status },
        code: { type: 'string', example: codeExample },
        message: { type: 'string', example: description },
      },
    },
  });
}

// ============================================================================
// 失败响应（从 ExceptionMap 派生）
// ----------------------------------------------------------------------------
// 用法：@ApiExceptionEnvelope(AuthExceptionMap, AuthExceptionCode.INVALID_REFRESH_TOKEN)
// 收益：status / message / code 全部由 ExceptionMap 这一单一数据源决定，
// Swagger 文档示例与运行时抛出的异常严格一致，杜绝手写三参数导致的漂移。
// ============================================================================
export function ApiExceptionEnvelope<TCode extends string>(
  map: Record<TCode, ExceptionInfo>,
  code: TCode,
) {
  const info = map[code];
  return ApiErrorEnvelope(info.status, info.message, info.code ?? code);
}
