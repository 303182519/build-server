import {
  INestApplication,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';

export const usePipes = (app: INestApplication) => {
  app.useGlobalPipes(
    new ValidationPipe({
      // 1. 自动把普通JSON对象转为DTO类实例 + 自动类型转换（string→number等）
      transform: true,
      // 2. 过滤掉 DTO 中未声明的字段（前端额外传垃圾字段直接剔除）安全必备
      whitelist: true,
      // 3. 如果前端传递了白名单以外的字段，直接抛出异常（严格模式）
      // forbidNonWhitelisted: true,
      // 4. 自动移除属性中 undefined 的值
      transformOptions: {
        excludeExtraneousValues: true,
      },
      // 跳过没有验证装饰器的类型（String Number Boolean等基础类型）, 默认是 false
      skipMissingProperties: false,
      // 5. 校验报错信息格式化，统一返回友好错误
      exceptionFactory: (validationErrors) => {
        const messages = validationErrors.map((err) => {
          return Object.values(err.constraints!).join(';');
        });
        // messages 格式化为数组
        /* [
              '名称 必须是字符串；名称 长度必须在 1~20 之间',
              '年龄 必须是整数；年龄 不能小于 0',
              '品种 必须是字符串'
            ] */
        return new BadRequestException({
          message: '参数校验失败',
          data: messages,
        });
      },
    }),
  );
};
