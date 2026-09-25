import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/shared/database/prisma/prisma.service';
import { generateSnowflakeId } from '@/shared/utils/snowflake';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import {
  AGENT_ACTION_TYPE,
  AGENT_RUN_STATUS,
  AgentActionType,
  AgentRunStatus,
  IAgentDraft,
  IAgentRunView,
} from './agent.types';
import { AgentApproval, Prisma } from '@prisma/client';

@Injectable()
export class ApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建审批记录（PENDING，payload=NULL 表示草稿生成中）。
   * threadId 唯一约束兜底并发重复创建。
   */
  async createPendingRun(
    threadId: string,
    userId: bigint,
    prompt: string,
  ): Promise<IAgentRunView> {
    const created = await this.prisma.agentApproval.create({
      data: {
        id: BigInt(generateSnowflakeId()),
        threadId,
        userId,
        prompt,
        actionType: AGENT_ACTION_TYPE.CREATE_POST_DRAFT,
        status: AGENT_RUN_STATUS.PENDING,
      },
    });
    return this.toView(created);
  }

  /**
   * 草稿生成完成，回填 payload。
   * 用 updateMany 限定 status=PENDING 且 payload IS NULL，防重复回填。
   */
  async attachDraft(
    threadId: string,
    draft: IAgentDraft,
  ): Promise<IAgentRunView> {
    await this.prisma.agentApproval.updateMany({
      where: {
        threadId,
        status: AGENT_RUN_STATUS.PENDING,
        payload: { equals: Prisma.DbNull },
      },
      data: { payload: draft as unknown as Prisma.InputJsonValue },
    });
    return this.getByThreadId(threadId);
  }

  /** 按 threadId 查询（LangGraph thread_id ↔ agent_approvals 一一对应） */
  async getByThreadId(threadId: string): Promise<IAgentRunView> {
    const row = await this.prisma.agentApproval.findUnique({
      where: { threadId },
    });
    if (!row) throw new ErrorException(ErrorExceptionCode.RUN_NOT_FOUND);
    return this.toView(row);
  }

  /** 按 id 查询 */
  async getById(id: bigint): Promise<IAgentRunView> {
    const row = await this.prisma.agentApproval.findUnique({ where: { id } });
    if (!row) throw new ErrorException(ErrorExceptionCode.RUN_NOT_FOUND);
    return this.toView(row);
  }

  /** 查询某用户的审批列表 */
  async listByUser(
    userId: bigint,
    status?: AgentRunStatus,
  ): Promise<IAgentRunView[]> {
    const rows = await this.prisma.agentApproval.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * 原子审批流转：仅当 status=PENDING 时更新为 APPROVED/REJECTED。
   * 利用 updateMany 的 WHERE 条件避免并发下重复审批（乐观锁思路）。
   * 返回更新后的记录；若已非 PENDING 则抛 RUN_NOT_PENDING。
   */
  async decide(
    id: bigint,
    userId: bigint,
    approve: boolean,
    reason?: string,
  ): Promise<IAgentRunView> {
    // 先查一次做归属校验，避免把非本人的记录也流转了
    const existing = await this.prisma.agentApproval.findUnique({
      where: { id },
    });
    if (!existing) throw new ErrorException(ErrorExceptionCode.RUN_NOT_FOUND);
    if (existing.userId !== userId)
      throw new ErrorException(ErrorExceptionCode.RUN_NOT_OWNER);

    const updated = await this.prisma.agentApproval.updateMany({
      where: { id, status: AGENT_RUN_STATUS.PENDING },
      data: {
        status: approve ? AGENT_RUN_STATUS.APPROVED : AGENT_RUN_STATUS.REJECTED,
        decidedAt: new Date(),
        reason: reason ?? null,
      },
    });

    if (updated.count === 0) {
      // 并发下已被其他请求审批，或状态早已不是 PENDING
      throw new ErrorException(ErrorExceptionCode.RUN_NOT_PENDING);
    }

    return this.getById(id);
  }

  /** 副作用执行完成，记录结果（postId）或错误 */
  async markExecuted(
    id: bigint,
    result?: { postId: string },
    error?: string,
  ): Promise<IAgentRunView> {
    await this.prisma.agentApproval.update({
      where: { id },
      data: {
        executedAt: new Date(),
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
      },
    });
    return this.getById(id);
  }

  private toView(row: AgentApproval): IAgentRunView {
    return {
      id: row.id.toString(),
      threadId: row.threadId,
      userId: row.userId.toString(),
      prompt: row.prompt,
      actionType: row.actionType as AgentActionType,
      status: row.status as AgentRunStatus,
      payload: row.payload as IAgentDraft | null,
      decidedAt: row.decidedAt,
      reason: row.reason,
      executedAt: row.executedAt,
      result: row.result as { postId: string } | null,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
