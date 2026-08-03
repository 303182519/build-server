import { getAppConfig } from '@/config/configuration';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const useSwagger = (app: INestApplication) => {
  const { swagger: swaggerConfig } = getAppConfig(app);

  if (!swaggerConfig.enabled) {
    return;
  }

  const config = new DocumentBuilder()
    .setTitle(swaggerConfig.title)
    .setDescription(swaggerConfig.description)
    .setVersion(swaggerConfig.version)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: '请输入Token，不需要Bearer前缀',
        in: 'header',
      },
      'access-token', // 授权名称，后面控制器使用
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(swaggerConfig.path, app, document);
};
