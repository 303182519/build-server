import { NestFactory } from '@nestjs/core';
import { Logger, VersioningType } from '@nestjs/common';
import { appUse } from './common/use';
import { AppModule } from './app.module';
import { getAppConfig } from './config/configuration';
import { useSwagger } from './shared/utils/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 获取配置
  const appConfig = getAppConfig(app);
  const { server, swagger, snowflake } = appConfig;

  // 设置api前缀
  app.setGlobalPrefix(server.apiPrefix);

  // 开启http请求版本
  // app.enableVersioning({
  //   type: VersioningType.URI,
  // });

  // 为整个应用绑定中间件
  appUse(app);

  useSwagger(app);

  await app.listen(server.port);

  const serverUrl = `http://127.0.0.1:${server.port}`;

  Logger.log(`\x1b[34mNODE_ENV: ${process.env.NODE_ENV}\x1b[0m`);
  Logger.log(`\x1b[34mApplication is running on: ${serverUrl}\x1b[0m`);
  Logger.log(
    `\x1b[34mSwagger is running on: ${serverUrl}/${swagger.path}\x1b[0m`,
  );
}
void bootstrap();
