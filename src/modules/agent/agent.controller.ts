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
import { Subscription } from 'rxjs';
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
import { AgentEventsService } from './agent-events.service';
import { ApprovalService } from './approval.service';
import { StartRunDto } from './dto/start-run.dto';
import { DecideRunDto } from './dto/decide-run.dto';
import {
  AGENT_RUN_STATUS,
  AGENT_SSE_EVENT,
  IAgentRunView,
  IAgentSseEvent,
} from './agent.types';

/** SSE 心跳间隔（ms），需小于反向代理空闲超时 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
/** 全局并发 SSE 连接数上限 */
const MAX_SSE_CONNECTIONS = 100;
/** 快照下发前允许缓冲的事件数上限 */
const MAX_PENDING_SSE_EVENTS = 100;

const idParam = ApiParam({ name: 'id', description: 'agent_approvals.id' });

@ApiTags('Agent - 人工审批工作流')
@ApiBearerAuth()
@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);
  private static activeSseConnections = 0;

  constructor(
    private readonly agentService: AgentService,
    private readonly agentEvents: AgentEventsService,
    private readonly approval: ApprovalService,
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
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
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

  /**
   * SSE 订阅单个 Agent 运行事件。
   * 逻辑与 JobsController#getEvents 同构：连接上限、心跳、快照 + 缓冲回放。
   */
  @Get('runs/:id/events')
  @ApiOperation({ summary: '订阅单个 Agent 运行事件（SSE）' })
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

    const conn = {
      closed: false,
      streaming: false,
      pending: [] as IAgentSseEvent[],
      heartbeat: undefined as NodeJS.Timeout | undefined,
      subscription: undefined as Subscription | undefined,
    };

    const teardown = () => {
      if (conn.closed) return;
      conn.closed = true;
      if (conn.heartbeat) clearInterval(conn.heartbeat);
      conn.subscription?.unsubscribe();
      conn.pending = [];
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

    const dispatch = (event: IAgentSseEvent) => {
      if (!conn.streaming) {
        if (conn.pending.length >= MAX_PENDING_SSE_EVENTS) {
          conn.pending.shift();
        }
        conn.pending.push(event);
        return;
      }
      if (!write(formatAgentSseEvent(event))) return;
      // 终态事件（COMPLETED / FAILED / REJECTED）后断开
      if (
        event.event === AGENT_SSE_EVENT.COMPLETED ||
        event.event === AGENT_SSE_EVENT.FAILED ||
        (event.event === AGENT_SSE_EVENT.DECIDED &&
          event.data.status === AGENT_RUN_STATUS.REJECTED)
      ) {
        teardown();
      }
    };

    // 先订阅，再读快照：避免快照读取与订阅建立之间的事件丢失
    conn.subscription = this.agentEvents.subscribe(id).subscribe(dispatch);

    req.on('close', teardown);
    res.on('close', teardown);
    res.on('error', teardown);

    // 鉴权 + 快照（未发送 SSE 头，异常可直接返回 HTTP 错误）
    let snapshot: IAgentRunView;
    try {
      const currentUser = useRequestUser();
      snapshot = await this.agentService.getRun(idBigInt, currentUser.id);
    } catch (error) {
      teardown();
      if (conn.closed) return;
      throw error;
    }

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

    conn.streaming = true;
    const snapshotEvent = formatAgentSseEvent({
      event: AGENT_SSE_EVENT.SNAPSHOT,
      data: snapshot,
    });

    if (!write(snapshotEvent)) return;

    // 快照已是终态：直接断开
    const isTerminal =
      snapshot.status !== AGENT_RUN_STATUS.PENDING || snapshot.error !== null;
    if (isTerminal) {
      teardown();
      return;
    }

    const buffered = conn.pending;
    conn.pending = [];
    for (const event of buffered) {
      if (conn.closed) break;
      // 跳过早于快照的缓冲事件，避免状态回退
      if (event.data.updatedAt <= snapshot.updatedAt) continue;
      dispatch(event);
    }
  }

  // 健康检查：确认 Agent 模块可用（LLM 配置是否齐全）
  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Agent 模块健康检查（LLM 配置）' })
  health() {
    return { enabled: true };
  }
}
