import {
  Controller,
  Get,
  ForbiddenException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Subscription } from 'rxjs';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { JOB_SSE_EVENT } from './constants/job.constants';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JobEventsService } from './events/job-events.service';
import { formatSseEvent } from './events/job-sse.util';
import { ListJobsDto } from './dto/list-jobs.dto';
import { QueryDeadLettersDto } from './dto/query-dead-letters.dto';
import { JobService } from './services/job.service';
import {
  JOB_TERMINAL_STATUSES,
  type IJobRunView,
  type IJobSseEvent,
} from './types/job.types';
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

/**
 * 快照下发前允许缓冲的事件数上限。
 *
 * 订阅建立（早于快照读取）到快照下发之间到达的事件先进入缓冲：该窗口只有一次
 * DB 查询，事件数极少；此上限仅用于防御异常放大，超限时丢弃最旧的缓冲事件
 * （保留最新状态语义）。
 */
const MAX_PENDING_SSE_EVENTS = 100;

@ApiTags('Jobs - 任务中心')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  /** 当前活跃 SSE 连接数（进程内计数器） */
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

  @Get('dead-letters')
  @ApiOperation({ summary: '查询死信任务（非终态且超过阈值未推进）' })
  @ApiQuery({
    name: 'timeoutMinutes',
    required: false,
    description: '死信阈值（分钟），默认 30',
  })
  @ApiQuery({
    name: 'name',
    required: false,
    description: '按任务名过滤',
  })
  listDeadLetters(@Query() query: QueryDeadLettersDto) {
    return this.jobService.findDeadLetters(query.timeoutMinutes, query.name);
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

    // ── 1. 并发连接数上限 ──
    // 检查与占用必须处于同一同步临界区（中间不得有 await）：否则并发请求会在
    // await 处全部通过检查、再各自自增，实际连接数将突破上限。
    if (JobsController.activeSseConnections >= MAX_SSE_CONNECTIONS) {
      // 此时未发送 SSE 响应头，交由全局异常过滤器输出统一响应体（含 bizCode）
      throw new ErrorException(ErrorExceptionCode.SSE_CONNECTIONS_EXCEEDED);
    }
    JobsController.activeSseConnections++;

    // 占用之后的每一条退出路径都必须经此释放，计数与真实连接同生命周期
    let released = false;
    const releaseConnection = () => {
      if (released) return;
      released = true;
      JobsController.activeSseConnections--;
    };

    // ── 2. 连接级状态 ──
    // 收进可变对象：teardown 必须在资源创建之前定义（订阅回调与断开事件都依赖它），
    // 又必须能清理「之后才创建」的定时器与订阅，因此句柄本身需要可变。
    const conn = {
      closed: false,
      streaming: false,
      pending: [] as IJobSseEvent[],
      heartbeat: undefined as NodeJS.Timeout | undefined,
      subscription: undefined as Subscription | undefined,
    };

    // 唯一的、幂等的清理入口：定时器 / 订阅 / 缓冲 / 计数 / 响应结束一并收敛。
    // 任何失败路径（写异常、背压、终态、客户端断开）都必须经此退出，否则会留下
    // 永不清除的定时器与订阅、以及永不回收的连接计数（最终耗尽上限导致全局 503）。
    const teardown = () => {
      if (conn.closed) return;
      conn.closed = true;
      if (conn.heartbeat) clearInterval(conn.heartbeat);
      conn.subscription?.unsubscribe();
      conn.pending = [];
      // 显式摘除监听器：避免 req/res 在 socket 回收前继续持有 teardown 闭包
      // （含 conn、snapshot 等引用）。监听器尚未注册时 off 为 no-op，安全。
      req.off('close', teardown);
      res.off('close', teardown);
      res.off('error', teardown);
      releaseConnection();
      // 未发送响应头时不 end：鉴权失败要由 GlobalExceptionsFilter 输出统一响应体
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // 连接已失效（socket 销毁等），无需处理
        }
      }
    };

    // 写入事件流。返回 false 表示连接已不可用（已 teardown），调用方必须停止推送。
    const write = (chunk: string): boolean => {
      if (conn.closed || res.writableEnded || res.destroyed) {
        teardown();
        return false;
      }
      try {
        if (res.write(chunk)) {
          return true;
        }
      } catch {
        teardown();
        return false;
      }
      // 背压：客户端消费速度低于事件产生速度。进度推送不做无界缓冲，
      // 主动断开让客户端重连（重连后先收到 snapshot，状态不会丢）。
      this.logger.warn(`SSE 客户端消费过慢，主动断开 jobId=${id}`);
      teardown();
      return false;
    };

    // 事件派发：快照下发前先缓冲，避免较旧的快照把已推送的新状态覆盖回退
    const dispatch = (event: IJobSseEvent) => {
      if (!conn.streaming) {
        if (conn.pending.length >= MAX_PENDING_SSE_EVENTS) {
          conn.pending.shift();
        }
        conn.pending.push(event);
        return;
      }
      if (!write(formatSseEvent(event))) return;
      if (JOB_TERMINAL_STATUSES.includes(event.data.status)) {
        teardown();
      }
    };

    // ── 3. 订阅事件流 ──
    // 订阅必须早于快照读取：若先读快照再订阅，「读快照 → 订阅生效」之间发出的事件
    // （Subject 无回放、Redis Pub/Sub 亦为 fire-and-forget）会被直接丢弃；
    // 若被丢弃的恰好是终态事件，客户端将永远等不到流结束。
    conn.subscription = this.jobEvents.subscribe(id).subscribe(dispatch);

    // ── 4. 连接断开 / 异常清理 ──
    // res 'close' 覆盖「响应正常结束」与「连接被提前终止」两种情形；
    // res 'error'（EPIPE 等 socket 错误）若无人监听会被 EventEmitter 抛出。
    req.on('close', teardown);
    res.on('close', teardown);
    res.on('error', teardown);

    // ── 5. 权限校验 + 读取快照（未发送 SSE 头，异常可正常返回 HTTP 状态码） ──
    let snapshot: IJobRunView;
    try {
      snapshot = await this.loadAuthorizedSnapshot(id);
    } catch (error) {
      teardown(); // headersSent=false，不会 end 响应
      // 鉴权期间客户端可能已断开（close / error 已触发 teardown）：此时再抛给
      // 全局过滤器，过滤器向已销毁的 socket 写响应只会产生噪声错误日志，静默退出。
      if (conn.closed) return;
      throw error;
    }

    // 鉴权期间客户端可能已断开（close / error 已触发 teardown）
    if (conn.closed) return;

    // ── 6. 发送 SSE 响应头 ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关闭反向代理对响应流的缓冲，否则事件会被攒批后才下发
    res.setHeader('X-Accel-Buffering', 'no');
    try {
      res.flushHeaders?.();
    } catch {
      // socket 已销毁等：响应不可用，直接清理退出
      teardown();
      return;
    }

    // ── 7. 心跳保活（写失败由 write 内部触发 teardown，不会遗留定时器） ──
    conn.heartbeat = setInterval(() => {
      write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_INTERVAL_MS);

    // ── 8. 下发快照，并回放订阅期间缓冲的事件 ──
    conn.streaming = true;
    // 快照不携带 id：省略 id 行使客户端 Last-Event-ID 保持最后一个数字序列号，
    // 避免 'snapshot' 这类非序列号 id 污染重连语义
    const snapshotEvent = formatSseEvent({
      event: JOB_SSE_EVENT.SNAPSHOT,
      data: snapshot,
    });

    if (!write(snapshotEvent)) return;

    if (JOB_TERMINAL_STATUSES.includes(snapshot.status)) {
      // 快照已是终态：终态不可逆，缓冲中更早的事件均被快照覆盖，无需回放
      teardown();
      return;
    }

    const buffered = conn.pending;
    conn.pending = [];
    for (const event of buffered) {
      if (conn.closed) break;
      // 跳过早于快照的缓冲事件：其状态变更已被快照读取点包含，
      // 回放会导致状态回退（如进度从 50% 倒退回 10%）。
      // 边界：updatedAt 相同表示同一行同一时刻的快照，跳过是安全的。
      if (event.data.updatedAt <= snapshot.updatedAt) continue;
      dispatch(event);
    }
  }

  /**
   * 读取任务并校验访问权限。
   *
   * 在发送 SSE 响应头之前调用，异常可直接抛出并由 GlobalExceptionsFilter 输出统一响应体。
   * createdBy 有值时必须匹配当前用户；无 createdBy 的系统任务拒绝非授权访问。
   */
  private async loadAuthorizedSnapshot(id: string): Promise<IJobRunView> {
    const snapshot = await this.jobService.getById(id);
    const currentUser = useRequestUser();

    if (
      !snapshot.createdBy ||
      snapshot.createdBy !== currentUser.id.toString()
    ) {
      throw new ForbiddenException('无权查看该任务');
    }

    return snapshot;
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

  @Post(':id/compensate')
  @ApiOperation({
    summary: '补偿死信任务（重新入队或标记失败）',
  })
  @idParam
  async compensate(@Param('id', ParseSnowflakePipe) id: bigint) {
    const result = await this.jobService.compensate(id.toString());
    if (!result) {
      throw new NotFoundException('任务已达终态或不可补偿');
    }
    return result;
  }
}
