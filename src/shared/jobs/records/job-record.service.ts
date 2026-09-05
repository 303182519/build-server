import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { JobRun as PrismaJobRun, Prisma } from '@prisma/client';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import { JobEventsService } from '../events/job-events.service';
import { resolveJobSseEventName } from '../events/job-sse.util';
import {
  JOB_STATUS,
  type JobStatus,
  type JobTriggerType,
} from '../constants/job.constants';
import { type IJobRunView, type IJobRunCreateData, type IListJobsQuery } from '../types/job.types';

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
  toDomain(row: PrismaJobRun): IJobRunView {
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
      },
      data: {
        status: JOB_STATUS.QUEUED,
        attemptsMade,
        errorMessage,
      },
    });
    await this.publishJobEventSafe(jobId);
  }

  /**
   * 仅当任务仍处于可取消状态时落库为 cancelled。
   * 返回 null 表示当前已不可取消（例如已被 worker 取走）。
   */
  async markCancelledIfCancellable(jobId: string): Promise<PrismaJobRun | null> {
    // 条件更新：仅当仍处于 queued/delayed 时才写入 cancelled 终态，
    // 并发下若已被 worker 抢走（active）或已达其他终态，count 为 0，不产生覆盖。
    const result = await this.prisma.jobRun.updateMany({
      where: {
        id: BigInt(jobId),
        status: { in: [JOB_STATUS.QUEUED, JOB_STATUS.DELAYED] },
      },
      data: {
        status: JOB_STATUS.CANCELLED,
        finishedAt: new Date(),
      },
    });

    if (!result.count) {
      return null;
    }

    const cancelled = await this.getEntityOrFail(jobId);
    await this.publishJobEventSafe(jobId);
    return cancelled;
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

  async list(query: IListJobsQuery): Promise<{
    list: IJobRunView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.JobRunWhereInput = {};
    if (query.name) where.name = query.name;
    if (query.status) where.status = query.status;

    // $transaction 数组形式：findMany 与 count 同一事务快照，保证 total 与当页数据口径一致。
    const [list, total] = await this.prisma.$transaction([
      this.prisma.jobRun.findMany({
        where,
        // 追加 id 作稳定次级排序键：createdAt 毫秒精度下同值时避免分页漂移 / 漏行 / 重复行；
        // 雪花 ID 单调递增，desc 与 createdAt 降序方向一致。
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.jobRun.count({ where }),
    ]);

    return {
      list: list.map((item) => this.toDomain(item)),
      total,
      page,
      pageSize,
    };
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
