import { Module } from '@nestjs/common';
// import { AppController } from './app.controller';
// import { AppService } from './app.service';
import { AppConfigModule } from '@/config/config.module';
import { PrismaModule } from './shared/database/prisma/prisma.module';
import { RedisCacheModule } from './shared/caching/cache.module';
import { appGuards } from './common/guards/app-guards';
import { ThrottlerConfigModule } from './shared/throttler/throttler.module';
import { StaticModule } from './shared/static/static.module';
import { CommonModule } from './common/common.module';
// import { PostsModule } from './modules/posts/posts.module';
import { JobsModule } from './shared/jobs/jobs.module';

import { modules } from './modules';
@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    PrismaModule,
    RedisCacheModule,
    JobsModule,
    ThrottlerConfigModule,
    StaticModule,
    ...modules,
  ],
  controllers: [],
  providers: [...appGuards],
})
export class AppModule {}
