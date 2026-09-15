import {
  JOB_STATUS,
  type JobSseEventName,
  type JobStatus,
  type JobTriggerType,
} from '../constants/job.constants';

export interface IJobContext<TPayload = unknown> {
  jobId: string;
  bullJobId?: string;
  name: string;
  payload: TPayload;
  attemptsMade: number;
  maxAttempts: number;
  updateProgress: (progress: number) => Promise<void>;
}

export interface IJobHandler<TPayload = unknown, TResult = unknown> {
  readonly name: string;
  handle(ctx: IJobContext<TPayload>): Promise<TResult>;
}

export interface ISubmitJobInput {
  name: string;
  payload?: unknown;
  delayMs?: number;
  attempts?: number;
  backoffMs?: number;
  triggerType?: JobTriggerType;
  createdBy?: string;
}

export interface IJobRunCreateData {
  name: string;
  queueName: string;
  payload?: unknown;
  maxAttempts: number;
  triggerType: JobTriggerType;
  createdBy?: string;
  status?: JobStatus;
}

export interface IJobRunView {
  id: string;
  name: string;
  queueName: string;
  status: JobStatus;
  progress: number;
  payload?: unknown;
  result?: unknown;
  errorMessage?: string | null;
  attemptsMade: number;
  maxAttempts: number;
  triggerType: JobTriggerType;
  createdBy?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  // updatedAt 用于 SSE 回放去重：订阅到快照下发之间缓冲的事件若早于快照读取点，
  // 其状态变更已被快照包含，回放会导致状态回退（如进度从 50% 倒退回 10%）。
  updatedAt: Date;
  createdAt: Date;
}

export interface IListJobsQuery {
  name?: string;
  status?: JobStatus;
  page?: number;
  pageSize?: number;
}

export interface IBullJobData {
  jobId: string;
  name: string;
  payload?: unknown;
}

export interface IJobSseEvent {
  /**
   * SSE event id。常规事件为递增数字序列号；快照事件不携带 id
   * （SSE 规范允许省略 id 行，客户端 Last-Event-ID 将保持最后一个数字序列号）。
   */
  id?: string;
  event: JobSseEventName;
  data: IJobRunView;
}

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  JOB_STATUS.COMPLETED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELLED,
] as const;

export const JOB_CANCELLABLE_STATUSES: readonly JobStatus[] = [
  JOB_STATUS.QUEUED,
  JOB_STATUS.DELAYED,
] as const;

/**
 * 死信任务视图：DB 记录处于非终态但超过阈值仍未推进。
 * deadReason 标识死信成因，供补偿逻辑决策参考。
 */
export interface IJobDeadLetterView {
  id: string;
  name: string;
  status: JobStatus;
  progress: number;
  attemptsMade: number;
  maxAttempts: number;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | null;
  deadReason: 'stuck_queued' | 'stuck_active' | 'stuck_delayed';
}
