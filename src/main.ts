import { NestFactory } from '@nestjs/core';
import { Logger, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { getAppConfig } from './config/configuration';
import { useSwagger } from './shared/utils/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { initSnowflake } from './shared/utils/snowflake';


async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: true,
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

  // 没开这个，容器 SIGTERM 时正在处理的请求会被一刀切断
  // OnApplicationShutdown 钩子也不会触发，连接池泄漏的经典源头
  app.enableShutdownHooks();

  await app.listen(server.port);

  const serverUrl = `http://127.0.0.1:${server.port}`;

  Logger.log(`\x1b[34mNODE_ENV: ${process.env.NODE_ENV}\x1b[0m`);
  Logger.log(`\x1b[34mApplication is running on: ${serverUrl}\x1b[0m`);
  Logger.log(
    `\x1b[34mSwagger is running on: ${serverUrl}/${swagger.path}\x1b[0m`,
  );
}
void bootstrap();
