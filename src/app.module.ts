import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from '@/config/config.module';
import { PrismaModule } from './shared/database/prisma/prisma.module';
import { RedisCacheModule } from './shared/caching/cache.module';
import { appGuards } from './common/guards/app-guards';
import { ThrottlerConfigModule } from './shared/throttler/throttler.module';
import { StaticModule } from './shared/static/static.module';
import { CommonModule } from './common/common.module';
import { PostsModule } from './modules/posts/posts.module';

// import { modules } from './modules';
@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    PrismaModule,
    RedisCacheModule,
    ThrottlerConfigModule,
    StaticModule,
    PostsModule,
  ],
  controllers: [AppController],
  providers: [AppService, ...appGuards],
})
export class AppModule {}
