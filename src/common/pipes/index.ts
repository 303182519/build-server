import {
  INestApplication,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common';

export const usePipes = (app: INestApplication) => {
  app.useGlobalPipes(
    new ValidationPipe({
      // 自动把普通JSON对象转为DTO类实例 + 自动类型转换（string→number等）
      transform: true,
      // 过滤掉 DTO 中未声明的字段（前端额外传垃圾字段直接剔除）安全必备
      whitelist: true,
      // 如果前端传递了白名单以外的字段，直接抛出异常（严格模式）
      // forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true, // query/param 的 string 自动转 number/boolean
      },
      // 校验报错信息格式化，统一返回友好错误
      exceptionFactory: (validationErrors) => {
        const messages = validationErrors.map((err) => ({
          field: err.property,
          message: Object.values(err.constraints ?? {}),
        }));

        return new BadRequestException({
          message: '参数校验失败',
          data: messages,
        });
      },
    }),
  );
};
