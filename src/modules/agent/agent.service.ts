import { Injectable, Logger } from '@nestjs/common';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { ApprovalService } from './approval.service';
import { AgentGraphService } from './agent-graph.service';
import { AgentEventsService } from './agent-events.service';
import { QwenService } from './qwen.service';
import { AGENT_EVENT_TYPE, IAgentRunView } from './agent.types';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly approval: ApprovalService,
    private readonly graph: AgentGraphService,
    private readonly qwen: QwenService,
    private readonly events: AgentEventsService,
  ) {}

  /**
   * 发起一次 Agent 运行：
   * 1. 创建审批记录（PENDING，payload=NULL）
   * 2. 异步启动 LangGraph（不 await，避免阻塞 HTTP 响应；状态经 SSE 推送）
   */
  async startRun(userId: bigint, prompt: string): Promise<IAgentRunView> {
    if (!this.qwen.isEnabled()) {
      throw new ErrorException(ErrorExceptionCode.AGENT_NOT_CONFIGURED);
    }

    const threadId = generateSnowflakeId();
    const run = await this.approval.createPendingRun(threadId, userId, prompt);

    // 异步执行图；失败已在 graph 内部兜底记录
    this.graph
      .startRun({
        threadId,
        runId: run.id,
        userId: userId.toString(),
        prompt,
      })
      .catch((err) => {
        this.logger.error(
          `startRun 异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    return run;
  }

  /** 查询运行详情（仅发起人可见） */
  async getRun(id: bigint, userId: bigint): Promise<IAgentRunView> {
    const run = await this.approval.getById(id);
    if (run.userId !== userId.toString()) {
      throw new ErrorException(ErrorExceptionCode.RUN_NOT_OWNER);
    }
    return run;
  }

  /** 查询当前用户的审批列表 */
  async listRuns(userId: bigint, status?: string): Promise<IAgentRunView[]> {
    return this.approval.listByUser(userId, status as never);
  }

  /**
   * 用户审批：
   * 1. DB 原子流转 PENDING → APPROVED/REJECTED（防并发重复审批）
   * 2. 无论批准/拒绝都恢复图（Command resume）：
   *    批准 → 执行副作用；拒绝 → 路由到 END。
   *    恢复后图运行循环统一发 run.completed（run.status 区分终态）。
   */
  async decideRun(
    id: bigint,
    userId: bigint,
    approve: boolean,
    reason?: string,
  ): Promise<IAgentRunView> {
    const run = await this.approval.decide(id, userId, approve, reason);

    try {
      await this.graph.resumeRun(run.threadId, approve, reason);
    } catch (err) {
      this.logger.error(
        `resumeRun 异常: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 恢复失败不影响审批状态本身；错误事件已由图循环下发，返回最新视图
      return this.approval.getById(id);
    }

    return this.approval.getById(id);
  }

  /**
   * 发起人取消运行（仅 PENDING 可取消）：
   * 1. DB 原子流转 PENDING → CANCELLED（防并发：与审批互斥）
   * 2. 草稿生成中：abort 图执行，终态 run.cancelled 事件由图循环兜底
   * 3. 挂起等待审批：删除 checkpoint，并直接下发 run.cancelled 事件
   */
  async cancelRun(
    id: bigint,
    userId: bigint,
    reason?: string,
  ): Promise<IAgentRunView> {
    const run = await this.approval.cancel(id, userId, reason);

    const aborted = this.graph.abortIfRunning(run.threadId);
    if (aborted) {
      // 图循环捕获 abort 后会按 DB 的 CANCELLED 状态发 run.cancelled
      return run;
    }

    // 挂起态 / 已结束态：清理 checkpoint（best-effort）并发终态事件
    await this.graph.discardCheckpoint(run.threadId);
    await this.events.append(run.id, AGENT_EVENT_TYPE.RUN_CANCELLED, {
      reason: run.reason ?? undefined,
      run,
    });

    return run;
  }
}
