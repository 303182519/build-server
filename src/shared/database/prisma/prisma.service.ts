import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { getConfig } from '@/config/configuration';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(configService: ConfigService) {
    const { database } = getConfig(configService);

    super({
      log: ['query', 'info', 'warn', 'error'],
      adapter: new PrismaMariaDb(database.url),
    });
  }

  async onModuleInit() {
    // 应用启动主动建立连接（可选；不写则惰性连接，第一次查询才连库）
    await this.$connect();
  }

  async onModuleDestroy() {
    // Nest关闭时主动断开连接，释放连接池
    await this.$disconnect();
  }
}
