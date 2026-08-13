import { INestApplication } from '@nestjs/common';


import { useMiddleware } from '../middleware';


export const appUse = (app: INestApplication) => {
  // 注册全局中间件
  useMiddleware(app);

};
