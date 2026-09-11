import { JobsModule } from '@/shared/jobs/jobs.module';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupExpiredRefreshTokensScheduler } from './cleanup-expired-refresh-tokens.scheduler';

@Module({
  imports: [ScheduleModule.forRoot(), JobsModule],
  providers: [CleanupExpiredRefreshTokensScheduler],
})
export class ScheduledTasksModule {}
