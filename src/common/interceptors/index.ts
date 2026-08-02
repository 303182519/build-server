import { ClassSerializerInterceptor, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoggingInterceptor } from './logging.interceptor';
import { PostResponseInterceptor } from './post-response.interceptor';
import { ResponseInterceptor } from './response.interceptor';
import { TimeoutInterceptor } from './timeout.interceptor';
// import { UserContextInterceptor } from './user-context.interceptor';

export const useInterceptors = (app: INestApplication) => {
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new PostResponseInterceptor(),
    new ResponseInterceptor(),
    // new UserContextInterceptor(),
    // https://docs.nestjs.cn/techniques/serialization
    new ClassSerializerInterceptor(app.get(Reflector)),
    new TimeoutInterceptor(app),
  );
};
