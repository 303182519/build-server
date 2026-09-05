import { Injectable } from '@nestjs/common';
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

  async markAttemptFailure(
    jobId: string,
    attemptsMade: number,
    error: unknown,
    isFinal: boolean,
  ): Promise<void> {
    const errorMessage = this.stringifyError(error);
    if (isFinal) {
      await this.prisma.jobRun.update({
        where: { id: BigInt(jobId) },
        data: {
          status: JOB_STATUS.FAILED,
          attemptsMade,
          errorMessage,
          finishedAt: new Date(),
        },
      });
      await this.publishJobEvent(jobId);
      return;
    }

    await this.prisma.jobRun.update({
      where: { id: BigInt(jobId) },
      data: {
        status: JOB_STATUS.QUEUED,
        attemptsMade,
        errorMessage,
      },
    });
    await this.publishJobEvent(jobId);
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

  async getEntityOrFail(jobId: string): Promise<JobRun> {
    const run = await this.prisma.jobRun.findUnique({
      where: { id: BigInt(jobId) },
    });
    if (!run) {
      throw new ErrorException(ErrorExceptionCode.JOB_NOT_FOUND);
    }
    return run;
  }

  private async publishJobEvent(jobId: string): Promise<void> {
    const run = await this.getEntityOrFail(jobId);
    this.publishJobRunEvent(run);
  }

  private publishJobRunEvent(run: JobRun): void {
    const view = this.toView(run);
    this.jobEvents.publish({
      event: resolveJobSseEventName(view.status),
      data: view,
    });
  }
}
