import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';

export const useMiddleware = (app: INestApplication) => {
  // 注册 cookie 解析中间件-https://docs.nestjs.cn/techniques/cookies
  app.use(cookieParser());
  // app.use(new LoggerMiddleware().use);
};
