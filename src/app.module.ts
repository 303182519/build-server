import { Module } from '@nestjs/common';
import { StaticModule } from './shared/static/static.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from '@/config/config.module';
import { PrismaModule } from './shared/database/prisma/prisma.module';
// import { modules } from './modules';
@Module({
  imports: [AppConfigModule, PrismaModule, StaticModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
