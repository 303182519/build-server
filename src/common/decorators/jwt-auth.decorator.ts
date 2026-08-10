import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * 访问权限的元数据的key
 */
export const JWT_META_KEY = 'JWT_META_KEY' as const;

/**
 * jwt元数据
 */
// export enum JwtMetaEnum {
//   PUBLIC,
// }

/**
 * 跳过jwt检查
 */
export const Public = () => SetMetadata(JWT_META_KEY, true);

/**
 * 通过装饰器获取JWT解密后注入的用户信息
 * JWT会把  request['user'] = payload;
 * https://docs.nestjs.cn/security/authentication#%E5%AE%9E%E7%8E%B0%E8%AE%A4%E8%AF%81%E5%AE%88%E5%8D%AB
 * 默认情况下 ValidationPipe 不会验证带有自定义装饰器注解的参数。
 * https://docs.nestjs.cn/overview/custom-decorators#%E4%BD%BF%E7%94%A8%E7%AE%A1%E9%81%93
 */

export const UserInfo = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user;
  },
);
