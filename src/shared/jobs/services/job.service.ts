import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { JobQueueService } from '../queue/job-queue.service';
import { JobRecordService } from '../records/job-record.service';
import { JobRegistryService } from '../registry/job-registry.service';
import {
  DEFAULT_JOB_QUEUE,
  JOB_STATUS,
  JOB_TRIGGER_TYPE,
} from '../constants/job.constants';
import { type ISubmitJobInput, type IJobRunView } from '../types/job.types';

/**
 * 任务提交 / 取消的业务入口（业务模块注入此服务，调用 submit/cancel）。
 *
 * 职责是编排「落库记录」与「入队」两步：先写 job_runs 拿到雪花 jobId，再带着该 jobId
 * 入 BullMQ；worker 消费时凭 jobId 回写执行记录。取消则反向：先查记录、判可取消，
 * 再从队列移除、最后以 DB 条件更新为准推进到 cancelled。
 */
@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    private readonly records: JobRecordService,
    private readonly queue: JobQueueService,
    private readonly registry: JobRegistryService,
  ) {}

  async submit(input: ISubmitJobInput): Promise<IJobRunView> {
    if (!this.registry.has(input.name)) {
      throw new ErrorException(ErrorExceptionCode.JOB_HANDLER_NOT_FOUND);
    }

    const maxAttempts = input.attempts ?? 1;
    const delayMs = input.delayMs ?? 0;
    const status = delayMs > 0 ? JOB_STATUS.DELAYED : JOB_STATUS.QUEUED;

    const run = await this.records.createQueued({
      name: input.name,
      queueName: DEFAULT_JOB_QUEUE,
      payload: input.payload,
      maxAttempts,
      triggerType: input.triggerType ?? JOB_TRIGGER_TYPE.MANUAL,
      createdBy: input.createdBy,
      status,
    });

    let bullJobId: string | undefined;
    try {
      const bullJob = await this.queue.enqueue(
        {
          jobId: run.id,
          name: input.name,
          payload: input.payload,
        },
        {
          jobId: run.id,
          delayMs,
          attempts: maxAttempts,
          backoffMs: input.backoffMs,
        },
      );
      bullJobId = bullJob.id ? String(bullJob.id) : undefined;
    } catch (error) {
      await this.records.markAttemptFailure(run.id, 0, error, true);
      this.logger.error(
        `Failed to enqueue jobId=${run.id} name=${input.name}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }

    if (bullJobId) {
      try {
        await this.records.attachBullJobId(run.id, bullJobId);
      } catch (error) {
        this.logger.error(
          `Failed to attach bullJobId=${bullJobId} for jobId=${run.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return this.records.getViewOrFail(run.id);

  }

}
