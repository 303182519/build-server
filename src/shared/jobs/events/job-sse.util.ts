import {
  JOB_SSE_EVENT,
  JOB_STATUS,
  JobStatus,
} from '../constants/job.constants';
import { IJobSseEvent } from '../types/job.types';

export const resolveJobSseEventName = (status: JobStatus) => {
  if (status === JOB_STATUS.COMPLETED) return JOB_SSE_EVENT.COMPLETED;
  if (status === JOB_STATUS.FAILED) return JOB_SSE_EVENT.FAILED;
  if (status === JOB_STATUS.CANCELLED) return JOB_SSE_EVENT.CANCELLED;
  return JOB_SSE_EVENT.UPDATED;
};

// ['11','22', '', ''].join('\n')\
// '11\n22\n\n'
// id 缺省时省略 id 行（SSE 规范允许）：客户端 Last-Event-ID 保持最后一个数字序列号
export const formatSseEvent = (event: IJobSseEvent) => {
  return [
    `event: ${event.event}`,
    ...(event.id !== undefined ? [`id: ${event.id}`] : []),
    `data: ${JSON.stringify(event.data)}`,
    '',
    '',
  ].join('\n');
};
