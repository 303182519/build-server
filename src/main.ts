import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { getAppConfig } from '@/config/configuration';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 获取配置
  const appConfig = getAppConfig(app);
  const { server, swagger, snowflake } = appConfig;

  // 设置api前缀
  app.setGlobalPrefix(server.apiPrefix);

  await app.listen(server.port);

  const serverUrl = `http://127.0.0.1:${server.port}`;

  Logger.log(`\x1b[34mNODE_ENV: ${process.env.NODE_ENV}\x1b[0m`);
  Logger.log(`\x1b[34mApplication is running on: ${serverUrl}\x1b[0m`);
  Logger.log(
    `\x1b[34mSwagger is running on: ${serverUrl}/${swagger.path}\x1b[0m`,
  );
}
void bootstrap();
