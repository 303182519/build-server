import { Module } from '@nestjs/common';
import { PrismaModule } from '@/shared/database/prisma/prisma.module';
import { RedisCacheModule } from '@/shared/caching/cache.module';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';

@Module({
  imports: [PrismaModule, RedisCacheModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
