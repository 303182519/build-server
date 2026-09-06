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
  type JobStatus,
} from '../constants/job.constants';
import {
  type ISubmitJobInput,
  type IJobRunView,
  type IListJobsQuery,
  type IJobDeadLetterView,
} from '../types/job.types';

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
    } catch (enqueueError) {
      // 落库成功但入队失败：将 DB 记录推进至 failed 终态，防止悬空 queued 记录
      try {
        await this.records.markAttemptFailure(run.id, 0, enqueueError, true);
      } catch (markError) {
        this.logger.error(
          `Failed to mark jobId=${run.id} as failed after enqueue failure: ${
            markError instanceof Error ? markError.message : String(markError)
          }`,
        );
      }
      this.logger.error(
        `Failed to enqueue jobId=${run.id} name=${input.name}`,
        enqueueError instanceof Error ? enqueueError.stack : undefined,
      );
      throw enqueueError;
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

  list(query: IListJobsQuery) {
    return this.records.list(query);
  }

  /**
   * 查询死信任务：DB 记录处于非终态且超过阈值仍未推进。
   *
   * 典型成因：
   * - worker 进程崩溃 / 重启，active job 无人推进
   * - BullMQ job 被 Redis 清理（重启 / maxLen 策略），queued/delayed 无人消费
   * - Redis 断连期间 BullMQ 丢失 job，DB 记录未同步更新
   */
  findDeadLetters(
    timeoutMinutes: number = 30,
    name?: string,
  ): Promise<IJobDeadLetterView[]> {
    return this.records.findDeadLetters(timeoutMinutes * 60 * 1000, name);
  }

  /**
   * 补偿单个死信任务。
   *
   * 策略：
   * - queued / delayed：检查 BullMQ 中 job 是否仍存在。
   *   仍存在 → 跳过（BullMQ 会自行消费）；
   *   不存在 → 重新入队，BullMQ 使用相同 jobId 保证幂等。
   * - active：检查 BullMQ 中 job 是否仍存在。
   *   仍存在 → 跳过（worker 可能仍在执行，避免双重执行）；
   *   不存在 → 推进至 failed 终态（worker 已崩溃，任务不可恢复）。
   *
   * 返回 null 表示任务已不可补偿（已达终态或已被其他流程处理）。
   */
  async compensate(jobId: string): Promise<IJobRunView | null> {
    const run = await this.records.getEntityOrFail(jobId);
    const status = run.status as JobStatus;

    // 已达终态，无需补偿
    if (
      status === JOB_STATUS.COMPLETED ||
      status === JOB_STATUS.FAILED ||
      status === JOB_STATUS.CANCELLED
    ) {
      return null;
    }

    // 检查 BullMQ 队列中 job 是否仍存在
    let bullJobExists = false;
    if (run.bullJobId) {
      const bullJob = await this.queue.getJob(run.bullJobId);
      bullJobExists = bullJob !== null;
    }

    if (status === JOB_STATUS.QUEUED || status === JOB_STATUS.DELAYED) {
      if (bullJobExists) {
        // BullMQ job 仍在队列中，等待 worker 消费，无需干预
        return this.records.getViewOrFail(jobId);
      }

      // BullMQ job 已丢失，重新入队（使用相同 jobId 保证幂等）
      this.logger.warn(
        `Compensating dead letter jobId=${jobId} name=${run.name}: re-enqueue (was ${status})`,
      );
      await this.queue.enqueue(
        { jobId: run.id.toString(), name: run.name, payload: run.payload },
        { jobId: run.id.toString(), attempts: run.maxAttempts },
      );
      return this.records.getViewOrFail(jobId);
    }

    if (status === JOB_STATUS.ACTIVE) {
      if (bullJobExists) {
        // BullMQ job 仍存在（worker 可能仍在执行），跳过以避免双重执行
        return this.records.getViewOrFail(jobId);
      }

      // Worker 已崩溃，BullMQ job 不存在，标记为 failed
      this.logger.warn(
        `Compensating dead letter jobId=${jobId} name=${run.name}: worker crashed, marking failed`,
      );
      await this.records.markAttemptFailure(
        jobId,
        run.attemptsMade,
        new Error('Worker process crashed — job timed out in active state'),
        true,
      );
      return this.records.getViewOrFail(jobId);
    }

    return null;
  }
}
