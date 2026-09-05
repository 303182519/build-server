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

  /**
   * 提交异步任务。
   *
   * 编排流程：「注册表校验 → 落库记录 → 入队 BullMQ → 回写 bullJobId」。
   *
   * 失败语义：
   * - 注册表未命中：直接抛 JOB_HANDLER_NOT_FOUND，不产生 DB 记录。
   * - 落库成功但入队失败：DB 记录推进至 failed 终态（附带错误信息），再向上抛出原始异常。
   * - bullJobId 回写失败：非致命，仅记录 warn 日志，不影响任务执行。
   */
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
  /**
   * 根据 jobId 获取任务详情。
   */
  getById(jobId: string): Promise<IJobRunView> {
    return this.records.getViewOrFail(jobId);
  }

  async cancel(jobId: string): Promise<IJobRunView> {
    const run = await this.records.getEntityOrFail(jobId);

    if (run.bullJobId) {
      try {
        await this.queue.remove(run.bullJobId);
      } catch (error) {
        this.logger.warn(
          `Failed to remove bullJobId=${run.bullJobId} during cancel: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const cancelled = await this.records.markCancelledIfCancellable(jobId);
    if (!cancelled) {
      throw new ErrorException(ErrorExceptionCode.JOB_NOT_CANCELLABLE);
    }

    return this.records.toDomain(cancelled);
  } 
}
