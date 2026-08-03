// validation-messages.ts
// 集中维护 class-validator 的中文校验文案，所有 DTO 共用
import { ValidationArguments } from 'class-validator';

// 字段英文名 → 中文名映射（新增字段时在这里补充即可）
const fieldLabels: Record<string, string> = {
  name: '名称',
  age: '年龄',
  breed: '品种',
};

// 取字段中文名，未配置则回退到英文字段名
function label(args: ValidationArguments): string {
  return fieldLabels[args.property] ?? args.property;
}

// 按校验器类型集中的中文模板
// 每个函数只在对应装饰器校验失败时被调用，可拿到 args.constraints 参数
export const ValidationMessages = {
  isString: (args: ValidationArguments) => `${label(args)} 必须是字符串`,

  isInt: (args: ValidationArguments) => `${label(args)} 必须是整数`,

  min: (args: ValidationArguments) =>
    `${label(args)} 不能小于 ${args.constraints[0]}`,

  max: (args: ValidationArguments) =>
    `${label(args)} 不能大于 ${args.constraints[0]}`,

  length: (args: ValidationArguments) =>
    `${label(args)} 长度必须在 ${args.constraints[0]}~${args.constraints[1]} 之间`,

  isNotEmpty: (args: ValidationArguments) => `${label(args)} 不能为空`,
};
