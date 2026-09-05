import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { JobRun as PrismaJobRun } from '@prisma/client';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { JobEventsService } from '../events/job-events.service';
import { resolveJobSseEventName } from '../events/job-sse.util';
import {
  JOB_STATUS,
  type JobStatus,
  type JobTriggerType,
} from '../constants/job.constants';
import { type IJobRunView, type IJobRunCreateData } from '../types/job.types';

const MAX_ERROR_MESSAGE_LENGTH = 2000;

/**
 * 任务执行记录（job_runs）持久化层。
 *
 * 只负责把领域状态机（queued → active → completed/failed/cancelled）翻译成 Prisma 写操作，
 * 并保证关键状态推进是「条件更新」（WHERE 带上旧状态），从而在并发 / 重复消费下不产生
 * 双重执行或错误的终态覆盖。对外只返回领域实体（JobRun），不暴露 Prisma 行。
 */
@Injectable()
export class JobRecordService {
  private readonly logger = new Logger(JobRecordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobEvents: JobEventsService,
  ) {}

  // ── 映射：DB 行 → 领域实体 ──────────────────────────────────────────
  private toDomain(row: PrismaJobRun): IJobRunView {
    return {
      id: row.id.toString(),
      name: row.name,
      queueName: row.queueName,
      status: row.status as JobStatus,
      progress: row.progress,
      payload: row.payload,
      result: row.result,
      errorMessage: row.errorMessage,
      attemptsMade: row.attemptsMade,
      maxAttempts: row.maxAttempts,
      // status/triggerType 的合法值由写入路径的常量枚举保证，这里直接断言收窄回领域类型。
      triggerType: row.triggerType as JobTriggerType,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
    };
  }

  /**
   * 创建任务记录（提交流程的第一步）。生成雪花 ID，落库状态为 queued。
   * 返回带 id 的领域实体，供调用方拿 id 去入队（BullMQ 数据里回传这个 id）。
   */
  async createQueued(data: IJobRunCreateData): Promise<IJobRunView> {
    const row = await this.prisma.jobRun.create({
      data: {
        id: BigInt(generateSnowflakeId()),
        name: data.name,
        queueName: data.queueName,
        triggerType: data.triggerType,
        status: data.status ?? JOB_STATUS.QUEUED,
        maxAttempts: data.maxAttempts ?? 1,
        createdBy: data.createdBy ? BigInt(data.createdBy) : null,
        ...(data.payload != null ? { payload: data.payload } : {}),
      },
    });
    return this.toDomain(row);
  }

  
  async attachBullJobId(jobId: string, bullJobId: string): Promise<void> {
    await this.prisma.jobRun.update({ where: { id: BigInt(jobId) }, data: { bullJobId } });
  }
  /**
   * 标记单次尝试失败。
   *
   * 使用条件更新（WHERE status = active）防止并发场景下覆盖终态：
   * - 若任务已被 cancel/complete，条件不匹配，update 静默跳过，不会错误回退状态。
   * - isFinal=true 时推进至 failed 终态；否则回退至 queued 等待下次重试。
   */
  async markAttemptFailure(
    jobId: string,
    attemptsMade: number,
    error: unknown,
    isFinal: boolean,
  ): Promise<void> {
    const errorMessage = this.stringifyError(error);

    if (isFinal) {
      await this.prisma.jobRun.updateMany({
        where: {
          id: BigInt(jobId),
          // 仅当任务仍处于 active 状态时才推进终态，避免覆盖 cancel/complete。
          status: JOB_STATUS.ACTIVE,
        },
        data: {
          status: JOB_STATUS.FAILED,
          attemptsMade,
          errorMessage,
          finishedAt: new Date(),
        },
      });
      await this.publishJobEventSafe(jobId);
      return;
    }

    // 非终态失败：回退至 queued 等待 BullMQ 重试。
    await this.prisma.jobRun.updateMany({
      where: {
        id: BigInt(jobId),
        status: JOB_STATUS.ACTIVE,
      },
      data: {
        status: JOB_STATUS.QUEUED,
        attemptsMade,
        errorMessage,
      },
    });
    await this.publishJobEventSafe(jobId);
  }

  private stringifyError(error: unknown): string {
    let message = 'Unknown error';
    if (error instanceof Error) message = error.message;
    else if (typeof error === 'string') message = error;
    else {
      try {
        message = JSON.stringify(error);
      } catch {
        message = String(error);
      }
    }

    if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
      return `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
    }
    return message;
  }

  async getEntityOrFail(jobId: string): Promise<PrismaJobRun> {
    const run = await this.prisma.jobRun.findUnique({
      where: { id: BigInt(jobId) },
    });
    if (!run) {
      throw new ErrorException(ErrorExceptionCode.JOB_NOT_FOUND);
    }
    return run;
  }


  async getViewOrFail(jobId: string): Promise<IJobRunView> {
    return this.toDomain(await this.getEntityOrFail(jobId));
  }

  /**
   * 安全发布 SSE 事件：读取当前记录状态并推送。
   *
   * - 事件发布属于「尽力而为」的副作用，不应阻断主流程。
   * - 若记录已被软删除（findUnique 返回 null）则静默跳过。
   * - 任何异常仅记录日志，不向上抛出。
   */
  private async publishJobEventSafe(jobId: string): Promise<void> {
    try {
      const run = await this.prisma.jobRun.findUnique({
        where: { id: BigInt(jobId) },
      });
      if (!run) return;

      const view = this.toDomain(run);
      this.jobEvents.publish({
        event: resolveJobSseEventName(view.status),
        data: view,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to publish SSE event for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
