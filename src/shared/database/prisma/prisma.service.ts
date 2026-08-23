import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { IsProduction } from '@/common/constants/environment';

type LogConfig =
  | [
      { emit: 'event'; level: 'query' },
      { emit: 'event'; level: 'warn' },
      { emit: 'event'; level: 'error' },
    ]
  | ['query', 'info', 'warn', 'error'];

type ClientOptions = Omit<Prisma.PrismaClientOptions, 'log'> & {
  log: LogConfig;
};

@Injectable()
export class PrismaService
  extends PrismaClient<ClientOptions>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: IsProduction
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : ['query', 'info', 'warn', 'error'],
    });
  }

  async onModuleInit() {
    if (IsProduction) {
      this.$on('warn', (e) => {
        this.logger.warn(e.message);
      });
      this.$on('error', (e) => {
        this.logger.error(e.message);
      });
    }

    this.$on('query', (e) => {
      if (e.duration > 100) {
        this.logger.error(
          `SLOW QUERY (${e.duration}ms):`,
          e.query.slice(0, 200),
          e.params,
        );
      }
    });

    await this.$connect();
    this.logger.log('mysql 连接已建立');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('mysql 连接已关闭');
  }
}
