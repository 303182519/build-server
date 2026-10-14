import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ContextModule } from '../src/common/context/context.module';
import { RequestContextService } from '../src/common/context/request-context.service';

/**
 * 上下文基础设施 e2e 冒烟（ADR-005）。
 *
 * 目的：实测 ClsMiddleware（由 ContextModule 挂载）能建立 CLS，并在请求最外层完成
 * requestId 的生成与落点（generateId + idGenerator + setup），使响应头与门面读取值一致。
 *
 * 做法：搭一个最小 Nest 应用（仅 ContextModule + 探针控制器），控制器从门面读取 requestId。
 * 若 CLS 未建立或 id 未写入，控制器将读到 undefined，断言失败。
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
class ProbeModule {}

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

  it('ClsMiddleware 建立 CLS 并回显 requestId：响应头与门面读取值一致', async () => {
    const upstream = 'upstream-rid-123';

    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('x-request-id', upstream)
      .expect(200);

    // 响应头回显上游 requestId
    expect(res.headers['x-request-id']).toBe(upstream);
    // CLS 也能读到此值 —— 证明上下文已建立且 id 已写入
    expect((res.body as { requestId?: string }).requestId).toBe(upstream);
  });
});
