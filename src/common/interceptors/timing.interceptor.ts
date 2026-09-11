import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import type { Request } from 'express';

// 慢请求探测。注册顺序决定它在最外层 —— 测到的耗时覆盖其它 interceptor + handler
// 注册顺序写反（这个排在 TransformInterceptor 内层）会让统计值偏小
@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimingInterceptor.name);
  private readonly slowMs = 500;

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const req = ctx.switchToHttp().getRequest<Request>();
    return next
      .handle()
      .pipe(finalize(() => this.report(req, Date.now() - start)));
  }

  private report(req: Request, ms: number): void {
    if (ms >= this.slowMs) {
      const reqId = req.headers['x-request-id'] as string | undefined;
      this.logger.warn(
        `SLOW ${req.method} ${req.originalUrl} ${ms}ms reqId=${reqId ?? '-'}`,
      );
    }
  }
}
