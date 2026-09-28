import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { ApiExceptionEnvelope } from '@/common/decorators/api-envelope.decorator';
import { Public, UserInfo } from '@/common/decorators/jwt-auth.decorator';
import { SkipTimeout } from '@/common/decorators/skip-timeout.decorator';
import { ParseSnowflakePipe } from '@/common/pipes/parse-snowflake.pipe';
import { useRequestUser } from '@/common/context/user-context';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import {
  AgentExceptionCode,
  AgentExceptionMap,
} from '@/common/exceptions/agent.exception';
import { formatAgentSseEvent } from './agent-sse.util';
import { AgentService } from './agent.service';
import {
  AgentEventTail,
  AgentEventsService,
  isValidStreamId,
} from './agent-events.service';
import { StartRunDto } from './dto/start-run.dto';
import { DecideRunDto } from './dto/decide-run.dto';
import { CancelRunDto } from './dto/cancel-run.dto';
import {
  AGENT_RUN_STATUS,
  AGENT_TERMINAL_EVENT_TYPES,
  IAgentRunView,
} from './agent.types';

/** SSE 心跳间隔（ms），需小于反向代理空闲超时 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
/** 全局并发 SSE 连接数上限 */
const MAX_SSE_CONNECTIONS = 100;

const idParam = ApiParam({ name: 'id', description: 'agent_approvals.id' });

/** 运行视图是否已是终态（APPROVED 但副作用执行中不算终态） */
const isTerminalView = (run: IAgentRunView): boolean =>
  run.status === AGENT_RUN_STATUS.REJECTED ||
  run.status === AGENT_RUN_STATUS.CANCELLED ||
  run.executedAt !== null ||
  run.error !== null;

@ApiTags('Agent - 人工审批工作流')
@ApiBearerAuth()
@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);
  private static activeSseConnections = 0;

  constructor(
    private readonly agentService: AgentService,
    private readonly agentEvents: AgentEventsService,
  ) {}

  @Post('runs')
  @ApiOperation({ summary: '发起 Agent 运行（生成文章草稿，待审批）' })
  @ApiExceptionEnvelope(
    AgentExceptionMap,
    AgentExceptionCode.AGENT_NOT_CONFIGURED,
  )
  startRun(@Body() dto: StartRunDto, @UserInfo() user: User) {
    return this.agentService.startRun(user.id, dto.prompt);
  }

  @Get('runs')
  @ApiOperation({ summary: '当前用户的 Agent 运行列表' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  listRuns(@UserInfo() user: User, @Query('status') status?: string) {
    return this.agentService.listRuns(user.id, status);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: '查询单个 Agent 运行（含审批状态）' })
  @idParam
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_FOUND)
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_OWNER)
  getRun(@Param('id', ParseSnowflakePipe) id: bigint, @UserInfo() user: User) {
    return this.agentService.getRun(id, user.id);
  }

  @Post('runs/:id/decide')
  @ApiOperation({ summary: '审批：批准（执行副作用）或拒绝' })
  @idParam
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_FOUND)
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_OWNER)
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_PENDING)
  decide(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() dto: DecideRunDto,
    @UserInfo() user: User,
  ) {
    return this.agentService.decideRun(id, user.id, dto.approve, dto.reason);
  }

  @Post('runs/:id/cancel')
  @ApiOperation({ summary: '取消 Agent 运行（仅 PENDING 状态可取消）' })
  @idParam
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_FOUND)
  @ApiExceptionEnvelope(AgentExceptionMap, AgentExceptionCode.RUN_NOT_OWNER)
  @ApiExceptionEnvelope(
    AgentExceptionMap,
    AgentExceptionCode.RUN_NOT_CANCELLABLE,
  )
  cancel(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() dto: CancelRunDto,
    @UserInfo() user: User,
  ) {
    return this.agentService.cancelRun(id, user.id, dto.reason);
  }

  /**
   * SSE 订阅单个 Agent 运行的事件流（run.started / message.delta / ...）。
   *
   * 基于 Redis Stream：
   *   1. 连接时先做鉴权快照（DB），异常在 SSE 头发送前以 HTTP 错误返回；
   *   2. XRANGE 回放 Last-Event-ID 之后的历史事件（断线续传）；
   *   3. XREAD BLOCK 尾读新事件；
   *   4. 收到 run.completed / run.cancelled / error 终态事件后断开；
   *   5. XREAD 异常时结束响应，浏览器 EventSource 会带 Last-Event-ID 自动重连。
   */
  @Get('runs/:id/events')
  @ApiOperation({ summary: '订阅单个 Agent 运行事件流（SSE）' })
  @idParam
  @SkipTimeout()
  async getEvents(
    @Param('id', ParseSnowflakePipe) idBigInt: bigint,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const id = idBigInt.toString();

    if (AgentController.activeSseConnections >= MAX_SSE_CONNECTIONS) {
      throw new ErrorException(ErrorExceptionCode.SSE_CONNECTIONS_EXCEEDED);
    }
    AgentController.activeSseConnections++;

    let released = false;
    const releaseConnection = () => {
      if (released) return;
      released = true;
      AgentController.activeSseConnections--;
    };

    const conn: {
      closed: boolean;
      heartbeat?: NodeJS.Timeout;
      tail?: AgentEventTail;
    } = { closed: false };

    const teardown = () => {
      if (conn.closed) return;
      conn.closed = true;
      if (conn.heartbeat) clearInterval(conn.heartbeat);
      void conn.tail?.close().catch(() => undefined);
      req.off('close', teardown);
      res.off('close', teardown);
      res.off('error', teardown);
      releaseConnection();
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // 连接已失效
        }
      }
    };

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
      this.logger.warn(`SSE 客户端消费过慢，主动断开 agentRunId=${id}`);
      teardown();
      return false;
    };

    // ── 1. 鉴权快照（SSE 头发送前，异常可直接返回 HTTP 错误）──
    let snapshot: IAgentRunView;
    try {
      const currentUser = useRequestUser();
      snapshot = await this.agentService.getRun(idBigInt, currentUser.id);
    } catch (error) {
      teardown();
      if (conn.closed) return;
      throw error;
    }

    // ── 2. 断线续传游标 + 历史回放（Redis Stream 持久缓冲）──
    const headerLastId = req.header('last-event-id');
    const afterId = isValidStreamId(headerLastId) ? headerLastId : undefined;
    const backlog = await this.agentEvents.listBacklog(id, afterId);

    if (conn.closed) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    try {
      res.flushHeaders?.();
    } catch {
      teardown();
      return;
    }

    conn.heartbeat = setInterval(() => {
      write(': heartbeat\n\n');
    }, SSE_HEARTBEAT_INTERVAL_MS);

    req.on('close', teardown);
    res.on('close', teardown);
    res.on('error', teardown);

    // 回放历史事件（XREAD 从最后一条回放事件之后开始，不重不漏）
    for (const entry of backlog) {
      if (conn.closed) return;
      if (!write(formatAgentSseEvent(entry))) return;
      if (AGENT_TERMINAL_EVENT_TYPES.includes(entry.event.type)) {
        teardown();
        return;
      }
    }

    // 快照已终态且 stream 中没有任何事件（stream 过期 / 从未产生）：直接断开
    if (backlog.length === 0 && isTerminalView(snapshot)) {
      teardown();
      return;
    }

    // ── 3. XREAD BLOCK 尾读新事件 ──
    const tailStartId = backlog.length
      ? backlog[backlog.length - 1].transportId
      : afterId;

    try {
      conn.tail = await this.agentEvents.createTail(id, {
        afterId: tailStartId,
      });
    } catch (err) {
      this.logger.error(
        `创建 Agent 事件尾读失败 agentRunId=${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      teardown();
      return;
    }

    for await (const entry of conn.tail) {
      if (conn.closed) return;
      if (entry === null) {
        // BLOCK 超时无新事件：终态 run 不再等待；非终态 run 继续保活
        if (isTerminalView(snapshot)) {
          teardown();
          return;
        }
        continue;
      }
      if (!write(formatAgentSseEvent(entry))) return;
      if (AGENT_TERMINAL_EVENT_TYPES.includes(entry.event.type)) {
        teardown();
        return;
      }
    }

    // 尾读迭代器结束（XREAD 连接错误等）：关闭连接，浏览器凭 Last-Event-ID 重连
    teardown();
  }

  // 健康检查：确认 Agent 模块可用（LLM 配置是否齐全）
  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Agent 模块健康检查（LLM 配置）' })
  health() {
    return { enabled: true };
  }
}
