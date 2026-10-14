import {
  Controller,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ContextModule } from '../src/common/context/context.module';
import { RequestContextService } from '../src/common/context/request-context.service';
import { RequestIdMiddleware } from '../src/common/middleware/request-id.middleware';

/**
 * 上下文基础设施 e2e 冒烟（ADR-005，风险 R1）。
 *
 * 目的：实测 ClsMiddleware（由 ContextModule 挂载）确实**先于** RequestIdMiddleware 执行——
 * 只有顺序正确，`RequestIdMiddleware` 才能把 requestId 写进 CLS。
 *
 * 做法：搭一个最小 Nest 应用（仅 ContextModule + 探针控制器），在应用里 apply 真实的
 * RequestIdMiddleware，控制器从门面读取 requestId。若 ClsMiddleware 晚于它执行，
 * 写入会被静默忽略，控制器将读到 undefined，断言失败。
 */

@Controller('probe')
class ProbeController {
  constructor(private readonly requestContext: RequestContextService) {}

  @Get()
  probe(): { requestId: string | undefined } {
    return { requestId: this.requestContext.getRequestId() };
  }
}

@Module({
  imports: [ContextModule],
  controllers: [ProbeController],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

describe('请求上下文（e2e）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('ClsMiddleware 先于 RequestIdMiddleware：CLS 中的 requestId 与响应头一致', async () => {
    const upstream = 'upstream-rid-123';

    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('x-request-id', upstream)
      .expect(200);

    // 响应头回显上游 requestId
    expect(res.headers['x-request-id']).toBe(upstream);
    // CLS 也能读到此值 —— 证明中间件顺序正确
    expect((res.body as { requestId?: string }).requestId).toBe(upstream);
  });
});
