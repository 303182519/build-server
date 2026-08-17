import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

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
          message: { type: 'string', example: 'ok' },
        },
      },
    }),
  );
}

// 失败响应：data 恒为 null
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
        code: { type: 'string', example: codeExample },
        data: { type: 'object', nullable: true, example: null },
        message: { type: 'string' },
      },
    },
  });
}
