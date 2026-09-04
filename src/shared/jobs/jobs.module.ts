import { Global, Module } from '@nestjs/common';
import { JobQueueModule } from './queue/job-queue.module';
import { JobQueueService } from './queue/job-queue.service';
import { JobProcessor } from './queue/job.processor';
import { JobRecordService } from './records/job-record.service';
import { JobRegistryService } from './registry/job-registry.service';
import { JobService } from './jobs.service';

/**
 * 任务系统统一入口模块。
 *
 * 聚合底层 BullMQ 队列（JobQueueModule）、执行记录持久化（JobRecordService）、
 * 处理器注册表（JobRegistryService）、worker（JobProcessor）与业务入口（JobService）。
 *
 * 业务模块接入方式：
 *   imports: [JobsModule]                       —— 拿到 JobService 提交/取消任务
 *   providers 里放实现 IJobHandler 的处理器      —— 构造时 registry.register(this)
 */
@Global()
@Module({
  imports: [JobQueueModule],
  providers: [
    JobRegistryService,
    JobRecordService,
    JobQueueService,
    JobService,
    JobProcessor,
  ],
  exports: [
    JobRegistryService,
    JobRecordService,
    JobQueueService,
    JobService,
    JobQueueModule,
  ],
})
export class JobsModule {}
