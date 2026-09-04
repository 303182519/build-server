import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { DEFAULT_JOB_QUEUE } from '../constants/job.constants';
import { IBullJobData } from '../types/job.types';

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);

  constructor(
    @InjectQueue(DEFAULT_JOB_QUEUE)
    private readonly queue: Queue<IBullJobData>,
  ) {}

  async enqueue(
    data: IBullJobData,
    options?: {
      delayMs?: number; // 延迟x毫秒秒执行
      attempts?: number; // 失败最多重试x次
      backoffMs?: number; // 失败重试间隔x毫秒
      jobId?: string; // 指定 Bull Job ID，默认使用 data.jobId
    },
  ) {
    const attempts = options?.attempts ?? 1;
    const opts: JobsOptions = {
      jobId: options?.jobId,
      attempts,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    };

    if (options?.delayMs && options.delayMs > 0) {
      opts.delay = options.delayMs;
    }

    if (attempts > 1) {
      opts.backoff = {
        type: 'fixed',
        delay: options?.backoffMs ?? 1000,
      };
    }

    const job = await this.queue.add(data.name, data, opts);
    this.logger.log(
      `Enqueued job name=${data.name} jobId=${data.jobId} bullJobId=${job.id}`,
    );
    return job;
  }

  async remove(bullJobId: string): Promise<boolean> {
    const job = await this.queue.getJob(bullJobId);
    if (!job) return false;

    const state = await job.getState();
    if (state === 'active' || state === 'completed' || state === 'failed') {
      return false;
    }

    await job.remove();
    return true;
  }
}
