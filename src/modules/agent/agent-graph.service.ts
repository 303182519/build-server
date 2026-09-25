import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';
import { getConfig } from '@/config/configuration';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { PostsService } from '../posts/posts.service';
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { ApprovalService } from './approval.service';
import { AgentEventsService } from './agent-events.service';
import { QwenService } from './qwen.service';
import { AGENT_SSE_EVENT, IAgentDraft, IAgentGraphState } from './agent.types';

/** LangGraph 图状态注解：只保留 interruption 恢复所需的最小字段 */
const AgentStateAnnotation = Annotation.Root({
  threadId: Annotation<string>,
  runId: Annotation<string>,
  userId: Annotation<string>,
  prompt: Annotation<string>,
  draft: Annotation<IAgentDraft | undefined>,
  approved: Annotation<boolean | undefined>,
  reason: Annotation<string | undefined>,
  postId: Annotation<string | undefined>,
  error: Annotation<string | undefined>,
});

/**
 * Agent 运行图：
 *
 *   START → generateDraft → waitForApproval（interrupt）→ decideRoute
 *     ├─ approved → executeSideEffect → END
 *     └─ rejected → END
 *
 * 图状态 checkpoint 持久化在 Redis（RedisSaver），支持多实例/重启恢复。
 * 审批域（status / decidedAt / result）以 MySQL agent_approvals 为权威源。
 */
@Injectable()
export class AgentGraphService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentGraphService.name);
  private checkpointer: RedisSaver | null = null;
  private graph: ReturnType<typeof this.buildGraph> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly qwen: QwenService,
    private readonly approval: ApprovalService,
    private readonly events: AgentEventsService,
    private readonly posts: PostsService,
  ) {}

  /**
   * 惰性初始化：首次调用时创建 RedisSaver 并编译图。
   * RedisSaver.fromUrl 内部会创建 RediSearch 索引；需要 Redis 8+（内置 JSON/Search）。
   */
  private async ensureGraph() {
    if (this.graph) return this.graph;

    const { redis } = getConfig(this.configService);
    const url = redis.url
      ? redis.url
      : redis.host
        ? `redis://${redis.password ? `:${encodeURIComponent(redis.password)}@` : ''}${redis.host}:${redis.port ?? 6379}${typeof redis.db === 'number' ? `/${redis.db}` : ''}`
        : undefined;

    if (!url) {
      throw new ErrorException(ErrorExceptionCode.AGENT_NOT_CONFIGURED);
    }

    try {
      this.checkpointer = await RedisSaver.fromUrl(url, {
        defaultTTL: 60 * 24, // checkpoint 保留 24 小时，足够人工审批窗口
        refreshOnRead: true,
      });
    } catch (err) {
      this.logger.error(
        `RedisSaver 初始化失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ErrorException(ErrorExceptionCode.AGENT_NOT_CONFIGURED);
    }

    this.graph = this.buildGraph();
    return this.graph;
  }

  private buildGraph() {
    return new StateGraph(AgentStateAnnotation)
      .addNode('generateDraft', this.generateDraft.bind(this))
      .addNode('waitForApproval', this.waitForApproval.bind(this))
      .addNode('executeSideEffect', this.executeSideEffect.bind(this))
      .addEdge(START, 'generateDraft')
      .addEdge('generateDraft', 'waitForApproval')
      .addConditionalEdges('waitForApproval', this.decideRoute.bind(this), {
        execute: 'executeSideEffect',
        end: END,
      })
      .addEdge('executeSideEffect', END)
      .compile({ checkpointer: this.checkpointer! });
  }

  /**
   * 启动一次 Agent 运行：生成草稿 → 挂起等待审批。
   * 调用方不 await 完整结果；运行状态通过 SSE / DB 查询。
   */
  async startRun(input: IAgentGraphState): Promise<void> {
    const graph = await this.ensureGraph();
    const config = { configurable: { thread_id: input.threadId } };

    try {
      await graph.invoke(input, config);
    } catch (err) {
      // 非 interrupt 导致的异常视为运行失败
      await this.handleRunFailure(input.threadId, input.runId, err);
    }
  }

  /**
   * 用户审批后恢复图执行（Command({resume})）。
   * 这是 LangGraph human-in-the-loop 的标准恢复方式。
   */
  async resumeRun(
    threadId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const graph = await this.ensureGraph();
    const config = { configurable: { thread_id: threadId } };

    try {
      // resume 值会作为 interrupt() 的返回值注入 waitForApproval 节点
      await graph.invoke(new Command({ resume: { approved, reason } }), config);
    } catch (err) {
      const run = await this.approval.getByThreadId(threadId);
      await this.handleRunFailure(threadId, run.id, err);
      throw new ErrorException(ErrorExceptionCode.GRAPH_INTERRUPT_FAILED);
    }
  }

  // ── 节点实现 ─────────────────────────────────────────────────────────────

  private async generateDraft(
    state: IAgentGraphState,
  ): Promise<Partial<IAgentGraphState>> {
    const draft = await this.qwen.generateDraft(state.prompt);
    const run = await this.approval.attachDraft(state.threadId, draft);

    this.events.publish({
      event: AGENT_SSE_EVENT.DRAFT_READY,
      data: run,
    });

    return { draft };
  }

  private async waitForApproval(
    state: IAgentGraphState,
  ): Promise<Partial<IAgentGraphState>> {
    // interrupt() 会把图挂起，直到外部通过 Command({resume}) 恢复。
    // resume 的值就是这里 interrupt() 的返回值。
    const decision: unknown = interrupt({
      type: 'approval_required',
      runId: state.runId,
      threadId: state.threadId,
      draft: state.draft,
    });
    console.log('waitForApproval-----------', decision);
    const { approved, reason } = decision as {
      approved: boolean;
      reason?: string;
    };

    const run = await this.approval.getByThreadId(state.threadId);
    this.events.publish({
      event: AGENT_SSE_EVENT.DECIDED,
      data: run,
    });

    return { approved, reason };
  }

  private decideRoute(state: IAgentGraphState): 'execute' | 'end' {
    return state.approved ? 'execute' : 'end';
  }

  private async executeSideEffect(
    state: IAgentGraphState,
  ): Promise<Partial<IAgentGraphState>> {
    if (!state.draft) {
      throw new Error('草稿缺失，无法执行副作用');
    }

    try {
      // 实际副作用：创建文章草稿（author=发起人，status=draft）
      const post = await this.posts.create(
        {
          title: state.draft.title,
          slug: state.draft.slug,
          content: state.draft.content,
          tags: state.draft.tags,
          status: 'draft',
        },
        state.userId,
      );

      const run = await this.approval.markExecuted(BigInt(state.runId), {
        postId: post.id.toString(),
      });

      this.events.publish({
        event: AGENT_SSE_EVENT.COMPLETED,
        data: run,
      });

      return { postId: post.id.toString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const run = await this.approval.markExecuted(
        BigInt(state.runId),
        undefined,
        message,
      );

      this.events.publish({
        event: AGENT_SSE_EVENT.FAILED,
        data: run,
      });

      return { error: message };
    }
  }

  private async handleRunFailure(
    threadId: string,
    runId: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Agent run ${threadId} 失败: ${message}`);

    try {
      const run = await this.approval.markExecuted(
        BigInt(runId),
        undefined,
        message,
      );
      this.events.publish({
        event: AGENT_SSE_EVENT.FAILED,
        data: run,
      });
    } catch (e) {
      this.logger.error(
        `记录运行失败状态失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  onModuleDestroy(): void {
    // RedisSaver 内部持有 redis client；交由进程退出时统一回收
    this.checkpointer = null;
    this.graph = null;
  }
}
