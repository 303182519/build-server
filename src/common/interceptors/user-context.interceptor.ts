import { RequestContextService } from '@/common/context/request-context.service';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';

/**
 * 将用户信息写入请求上下文（CLS）。
 *
 * 为什么仍用拦截器：用户信息在 JWT 守卫之后才可用，而守卫的 canActivate 没有「包裹后续所有操作」
 * 的语义，无法像拦截器那样把用户写进这条请求的上下文。拦截器晚于守卫执行，因此能拿到 req.user。
 *
 * 迁移前这里用 userContextStorage.run() 建立用户上下文；迁移后（ADR-005）改为写入 nestjs-cls
 * 的统一 store（由 ClsMiddleware 在请求最外层建立），注册位置（APP_INTERCEPTOR）不变。
 */
@Injectable()
export class UserContextInterceptor implements NestInterceptor {
  constructor(private readonly requestContext: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();

    // 无用户（如公开接口）时不写入，等价于迁移前 run(undefined) 建立空用户上下文。
    if (request.user) {
      this.requestContext.setUser(request.user);
    }

    return next.handle();
  }
}
