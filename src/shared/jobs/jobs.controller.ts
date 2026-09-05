import {
  Controller,
  Get,
  ForbiddenException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JOB_SSE_EVENT } from './constants/job.constants';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JobEventsService } from './events/job-events.service';
import { formatSseEvent } from './events/job-sse.util';
import { ListJobsDto } from './dto/list-jobs.dto';
import { JobService } from './services/job.service';
import { JOB_TERMINAL_STATUSES } from './types/job.types';
import { SkipTimeout } from '@/common/decorators/skip-timeout.decorator';
import { ParseSnowflakePipe } from '@/common/pipes/parse-snowflake.pipe';
import { useRequestUser } from '@/common/context/user-context';

// 路径参数 :id 的 API 参数装饰器
const idParam = ApiParam({
  name: 'id',
  description: 'job_runs.id',
});

/** SSE 心跳间隔（ms），需小于反向代理空闲超时（Nginx 默认 60s） */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** 全局并发 SSE 连接数上限 */
const MAX_SSE_CONNECTIONS = 100;

@ApiTags('Jobs - 任务中心')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  /** 当前活跃 SSE 连接数（模块级计数器） */
  private static activeSseConnections = 0;

  constructor(
    private readonly jobService: JobService,
    private readonly jobEvents: JobEventsService,
  ) {}

  @Get()
  @ApiOperation({ summary: '分页查询任务执行记录' })
  list(@Query() query: ListJobsDto) {
    return this.jobService.list(query);
  }

  @Get(':id/events')
  @ApiOperation({ summary: '订阅单个任务状态事件（SSE）' })
  @idParam
  @SkipTimeout()
  async getEvents(
    @Param('id', ParseSnowflakePipe) idBigInt: bigint,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const id = idBigInt.toString();

    // ── 1. 并发连接数限制（SSE 头未发送，可正常返回 HTTP 错误） ──
    if (JobsController.activeSseConnections >= MAX_SSE_CONNECTIONS) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        code: '15503',
        message: 'SSE 连接数已达上限，请稍后重试',
      });
      return;
    }

    // ── 2. 先查 snapshot（此时未发 SSE 头，异常可正常返回 HTTP 状态码） ──
    const snapshot = await this.jobService.getById(id);

    // ── 3. 权限校验：createdBy 有值时必须匹配当前用户 ──
    if (snapshot.createdBy) {
      const currentUser = useRequestUser();
      if (snapshot.createdBy !== currentUser.id.toString()) {
        throw new ForbiddenException('无权查看该任务');
      }
    }

    // ── 4. 发送 SSE 响应头 ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    JobsController.activeSseConnections++;

    // ── 5. 状态管理：closed 标志位防止 write-after-end ──
    let closed = false;

    const safeWrite = (chunk: string): boolean => {
      if (closed) return false;
      try {
        const ok = res.write(chunk);
        if (!ok) {
          // write 返回 false 表示背压过高，但尚未关闭
          return true;
        }
        return true;
      } catch {
        closed = true;
        return false;
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatInterval);
      subscription.unsubscribe();
      JobsController.activeSseConnections--;
      if (!res.writableEnded) {
        res.end();
      }
    };

    // ── 6. 心跳保活 ──
    const heartbeatInterval = setInterval(() => {
      safeWrite(': heartbeat\n\n');
    }, SSE_HEARTBEAT_INTERVAL_MS);

    // ── 7. 订阅事件流 ──
    const subscription = this.jobEvents.subscribe(id).subscribe((event) => {
      if (!safeWrite(formatSseEvent(event))) return;
      if (JOB_TERMINAL_STATUSES.includes(event.data.status)) {
        cleanup();
      }
    });

    // ── 8. 客户端断开清理 ──
    req.on('close', cleanup);

    // ── 9. 发送 snapshot 事件 ──
    const snapshotEvent = formatSseEvent({
      id: 'snapshot',
      event: JOB_SSE_EVENT.SNAPSHOT,
      data: snapshot,
    });
    if (!safeWrite(snapshotEvent)) return;

    if (JOB_TERMINAL_STATUSES.includes(snapshot.status)) {
      cleanup();
    }
  }

  @Get(':id')
  @ApiOperation({ summary: '查询单个任务状态（轮询）' })
  @idParam
  getById(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.jobService.getById(id.toString());
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '取消 queued / delayed 任务' })
  @idParam
  cancel(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.jobService.cancel(id.toString());
  }
}
