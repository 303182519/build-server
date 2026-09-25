import { Injectable, Logger } from '@nestjs/common';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { ApprovalService } from './approval.service';
import { AgentGraphService } from './agent-graph.service';
import { QwenService } from './qwen.service';
import { IAgentRunView } from './agent.types';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly approval: ApprovalService,
    private readonly graph: AgentGraphService,
    private readonly qwen: QwenService,
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
   * 2. 恢复 LangGraph 继续执行副作用
   */
  async decideRun(
    id: bigint,
    userId: bigint,
    approve: boolean,
    reason?: string,
  ): Promise<IAgentRunView> {
    const run = await this.approval.decide(id, userId, approve, reason);

    // 拒绝：不恢复图执行，直接返回
    if (!approve) return run;

    // 批准：恢复图执行副作用
    try {
      await this.graph.resumeRun(run.threadId, approve, reason);
    } catch (err) {
      this.logger.error(
        `resumeRun 异常: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 恢复失败不影响审批状态本身；记录错误并返回最新视图
      return this.approval.getById(id);
    }

    return this.approval.getById(id);
  }
}
