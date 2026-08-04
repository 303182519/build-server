import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { IsProduction } from '@/common/constants/environment';

type LogConfig =
  | [{ emit: 'event'; level: 'warn' }, { emit: 'event'; level: 'error' }]
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

    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
