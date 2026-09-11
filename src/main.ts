import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { getAppConfig } from './config/configuration';
import { useSwagger } from './shared/utils/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { initSnowflake } from './shared/utils/snowflake';
import { JobBoardService } from './shared/jobs/board/job-board.service';
import { Logger as PinoLogger } from 'nestjs-pino';

async function bootstrap() {
  // bufferLogs：启动早期日志先缓存，等 useLogger 桥接后再统一输出，避免丢失启动日志
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // 把 NestJS 全局 Logger 桥接到 pino：业务代码里的 new Logger() / Logger.log()
  // 也会走结构化日志。否则 pino 只覆盖 HTTP 访问日志，形成两套并行的日志系统。
  app.useLogger(app.get(PinoLogger));

  // 本地开发环境开启跨域，生产环境关闭，原因：生产环境需要在Nginx后开启跨域，Nginx会自动处理跨域问题
  app.enableCors({
    origin: ['http://localhost:3001'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true, // 允许携带cookie凭证
  });

  // 获取配置
  const appConfig = getAppConfig(app);
  const { server, swagger, snowflake } = appConfig;

  // 初始化雪花Id
  initSnowflake(BigInt(snowflake.workerId), BigInt(snowflake.datacenterId));

  // 全局：BigInt 输出JSON自动转字符串
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  // 设置api前缀
  app.setGlobalPrefix(server.apiPrefix);

  // 下面的配置根据实际情况选择开启, 只有确定请求一定经过你可控的代理（Nginx / 负载均衡），才打开这个配置。
  // 没有代理，直接对外：trust proxy: false（默认）
  // 1. 同机器部署(Nginx+Nest)，安全组限制3000仅本机访问, 即使接入CDN，这套配置也可以继续用，不用改trust‑proxy。
  // app.set('trust proxy', 'loopback'); // 信任来自环回地址的请求
  // 2. 跨机器部署 Nginx (192.168.200.128) → Nest
  // app.set('trust proxy', ['192.168.200.128']); // 信任来自Nginx的请求

  // 开启http请求版本
  // app.enableVersioning({
  //   type: VersioningType.URI,
  // });

  useSwagger(app);

  // ── Bull Board 任务监控面板 ──────────────────────────────────────
  // 必须在 NestJS 路由初始化之前挂载，以绕过全局 Guard 链
  // （JwtAuthGuard / PermissionGuard / ThrottlerGuard）。
  // 面板认证由 JobBoardService 内部中间件独立负责。
  const boardService = app.get(JobBoardService, { strict: false });
  const boardMiddleware = boardService.setupMiddleware();
  app.use(appConfig.board.path, boardMiddleware);
  if (appConfig.board.enabled) {
    Logger.log(
      `Bull Board: http://127.0.0.1:${server.port}${appConfig.board.path}`,
    );
  }

  // 没开这个，容器 SIGTERM 时正在处理的请求会被一刀切断
  // OnApplicationShutdown 钩子也不会触发，连接池泄漏的经典源头
  app.enableShutdownHooks();

  await app.listen(server.port);

  const serverUrl = `http://127.0.0.1:${server.port}`;

  // 不再手工拼接 ANSI 颜色码：日志已统一走 pino，生产环境是 JSON（颜色码会变成噪声），
  // 开发环境的着色由 pino-pretty 负责。
  Logger.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  Logger.log(`Application is running on: ${serverUrl}`);
  Logger.log(`Swagger is running on: ${serverUrl}/${swagger.path}`);
}
void bootstrap();
