import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { DEFAULT_JOB_QUEUE } from '../constants/job.constants';
import { IBullJobData } from '../types/job.types';

/**
 * BullMQ 自定义 jobId 的固定前缀。
 *
 * 【为什么必须加】BullMQ 的 `Job.validateOptions()` 会执行
 * `` `${parseInt(jobId, 10)}` === jobId `` 判定，命中即抛 `Custom Id cannot be integers`
 * ——即「纯整数字符串」同样被拒绝（不只是 number 类型）。本项目的 jobId 取自
 * `generateSnowflakeId()`，是纯数字串，原样透传必然被拒。
 *
 * 【为什么用 `-` 而不是 `:`】BullMQ 另有一条「jobId 不得包含 `:`（除非 split(':').length === 3）」
 * 的校验（为旧版 repeatable job 保留的兼容规则），用 `-` 可同时避开两条限制。
 */
const BULL_JOB_ID_PREFIX = 'job-';

/**
 * 把业务雪花 ID 转成合法的 BullMQ jobId。
 *
 * 幂等：已带前缀时原样返回，避免重复转换产生 `job-job-xxx`（死信补偿等路径会重复入队）。
 *
 * 仅作用于 BullMQ 的 `opts.jobId`。**不得**用它改写 `IBullJobData.jobId`
 * ——worker 侧用 `BigInt(data.jobId)` 反查 job_runs，必须保持纯雪花 ID。
 */
const toBullJobId = (jobId: string): string =>
  jobId.startsWith(BULL_JOB_ID_PREFIX)
    ? jobId
    : `${BULL_JOB_ID_PREFIX}${jobId}`;

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
      jobId?: string; // 业务 jobId（雪花 ID），入队时统一加前缀转成 BullMQ jobId；不传则由 BullMQ 自动生成
    },
  ) {
    const attempts = options?.attempts ?? 1;
    const opts: JobsOptions = {
      // 必须经 toBullJobId 转换：纯数字 jobId 会被 BullMQ 直接拒绝（见 BULL_JOB_ID_PREFIX 注释）。
      // 转换是确定性的，故同一业务 jobId 重复入队仍命中同一个 BullMQ job，幂等语义不变。
      jobId: options?.jobId ? toBullJobId(options.jobId) : undefined,
      attempts,
      // removeOnComplete / removeOnFail 已在 JobQueueModule defaultJobOptions 统一配置，
      // 此处不再重复声明，避免两处数值不一致导致维护混乱
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

  /**
   * 查询 BullMQ 队列中指定 job 是否仍存在。
   * 返回 null 表示 job 已不在队列中（已消费 / 已清理 / 已丢失）。
   */
  async getJob(bullJobId: string) {
    return this.queue.getJob(bullJobId);
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
