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
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
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
import {
  AGENT_ACTION_TYPE,
  AGENT_EVENT_TYPE,
  AGENT_RUN_STATUS,
  AgentEventType,
  IAgentDraft,
  IAgentGraphState,
} from './agent.types';

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

/** getState() 快照中 interrupt 条目的结构化视图（避免依赖内部类型导出） */
interface IStateInterrupt {
  value?: unknown;
}
interface IStateTaskShape {
  interrupts?: IStateInterrupt[];
}
interface IStateSnapshotShape {
  next?: string[];
  tasks?: IStateTaskShape[];
}

/**
 * Agent 运行图：
 *
 *   START → generateDraft → waitForApproval（interrupt）→ decideRoute
 *     ├─ approved → executeSideEffect → END
 *     └─ rejected → END
 *
 * 图状态 checkpoint 持久化在 Redis（RedisSaver），支持多实例/重启恢复。
 * 审批域（status / decidedAt / result）以 MySQL agent_approvals 为权威源。
 *
 * 流式链路：graph.stream(streamMode:'messages') → 事件层（AgentEventsService
 * XADD Redis Stream）→ SSE → Browser。
 */
@Injectable()
export class AgentGraphService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentGraphService.name);
  private checkpointer: RedisSaver | null = null;
  private graph: ReturnType<typeof this.buildGraph> | null = null;

  /** 正在执行（未挂起）的运行：threadId → AbortController，供取消中断 */
  private readonly runners = new Map<string, AbortController>();

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
      .addNode(
        'generateDraft',
        this.wrapNode('generateDraft', this.generateDraft.bind(this)),
      )
      .addNode(
        'waitForApproval',
        this.wrapNode('waitForApproval', this.waitForApproval.bind(this)),
      )
      .addNode(
        'executeSideEffect',
        this.wrapNode('executeSideEffect', this.executeSideEffect.bind(this)),
      )
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
   * 节点生命周期包装：统一发 node.started / node.completed。
   * 节点抛错（含 interrupt 冒泡）时不发 completed，由运行循环兜底终态事件。
   */
  private wrapNode(
    name: string,
    handler: (
      state: IAgentGraphState,
      config?: RunnableConfig,
    ) => Promise<Partial<IAgentGraphState>> | Partial<IAgentGraphState>,
  ) {
    return async (
      state: IAgentGraphState,
      config?: RunnableConfig,
    ): Promise<Partial<IAgentGraphState>> => {
      await this.emit(state.runId, AGENT_EVENT_TYPE.NODE_STARTED, {
        node: name,
      });
      const update = await handler(state, config);
      await this.emit(state.runId, AGENT_EVENT_TYPE.NODE_COMPLETED, {
        node: name,
      });
      return update;
    };
  }

  /** 事件下发永远不应中断图执行 */
  private async emit(
    runId: string,
    type: AgentEventType,
    data: unknown,
  ): Promise<void> {
    try {
      await this.events.append(runId, type, data);
    } catch (err) {
      this.logger.warn(
        `事件下发失败 type=${type} runId=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 启动一次 Agent 运行：生成草稿 → 挂起等待审批。
   * 调用方不 await 完整结果；运行状态通过 SSE 事件流 / DB 查询。
   */
  async startRun(input: IAgentGraphState): Promise<void> {
    const graph = await this.ensureGraph();
    const abort = new AbortController();
    this.runners.set(input.threadId, abort);
    const config: RunnableConfig = {
      configurable: { thread_id: input.threadId },
      signal: abort.signal,
    };

    await this.emit(input.runId, AGENT_EVENT_TYPE.RUN_STARTED, {
      threadId: input.threadId,
      actionType: AGENT_ACTION_TYPE.CREATE_POST_DRAFT,
      prompt: input.prompt,
    });

    try {
      const stream = await graph.stream(input, {
        ...config,
        streamMode: 'messages',
      });
      await this.consumeMessageStream(stream, input.runId);
      await this.afterStream(graph, input.threadId, input.runId, config);
    } catch (err) {
      await this.handleStreamError(
        err,
        graph,
        input.threadId,
        input.runId,
        config,
      );
    } finally {
      this.runners.delete(input.threadId);
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
    const run = await this.approval.getByThreadId(threadId);
    const abort = new AbortController();
    this.runners.set(threadId, abort);
    const config: RunnableConfig = {
      configurable: { thread_id: threadId },
      signal: abort.signal,
    };

    try {
      const stream = await graph.stream(
        new Command({ resume: { approved, reason } }),
        { ...config, streamMode: 'messages' },
      );
      await this.consumeMessageStream(stream, run.id);
      await this.afterStream(graph, threadId, run.id, config);
    } catch (err) {
      await this.handleStreamError(err, graph, threadId, run.id, config);
      throw new ErrorException(ErrorExceptionCode.GRAPH_INTERRUPT_FAILED);
    } finally {
      this.runners.delete(threadId);
    }
  }

  /**
   * 若运行正在执行（草稿生成中），中断其 AbortController。
   * 返回 true 表示已通知运行循环（终态事件由循环兜底发）；
   * 返回 false 表示运行挂起在 interrupt / 已结束，由调用方处理。
   */
  abortIfRunning(threadId: string): boolean {
    const controller = this.runners.get(threadId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 挂起态取消：尽力删除 checkpoint，避免残留挂起线程（TTL 也会兜底回收） */
  async discardCheckpoint(threadId: string): Promise<void> {
    try {
      if (!this.checkpointer) {
        await this.ensureGraph();
      }
      await this.checkpointer?.deleteThread(threadId);
    } catch (err) {
      this.logger.warn(
        `删除 checkpoint 失败（将由 TTL 回收）threadId=${threadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── 流消费 ──────────────────────────────────────────────────────────────

  /**
   * 消费 graph.stream(streamMode:'messages') 的 token 分片，转 message.delta。
   * chunk 形如 [BaseMessageChunk, metadata]，metadata.langgraph_node 标记来源节点。
   */
  private async consumeMessageStream(
    stream: AsyncIterable<unknown>,
    runId: string,
  ): Promise<void> {
    for await (const chunk of stream) {
      const [message, metadata] = chunk as [
        BaseMessage,
        Record<string, unknown> | undefined,
      ];
      const content = this.extractText(message);
      if (!content) continue;
      const node =
        metadata && typeof metadata.langgraph_node === 'string'
          ? metadata.langgraph_node
          : undefined;
      await this.emit(runId, AGENT_EVENT_TYPE.MESSAGE_DELTA, {
        content,
        ...(node ? { node } : {}),
      });
    }
  }

  /** 兼容字符串 content 与多模态 content parts */
  private extractText(message: BaseMessage): string {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part && typeof part === 'object' && 'text' in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .join('');
    }
    return '';
  }

  /** 流正常结束后的状态分流：挂起 → interrupt；结束 → run.completed */
  private async afterStream(
    graph: ReturnType<typeof this.buildGraph>,
    threadId: string,
    runId: string,
    config: RunnableConfig,
  ): Promise<void> {
    const snapshot = (await graph.getState(config)) as IStateSnapshotShape;
    const pendingInterrupt = this.findInterrupt(snapshot);
    if (pendingInterrupt) {
      const value = (pendingInterrupt.value ?? {}) as {
        draft?: IAgentDraft;
      };
      await this.emit(runId, AGENT_EVENT_TYPE.INTERRUPT, {
        type: 'approval_required',
        threadId,
        runId,
        draft: value.draft ?? null,
      });
      return;
    }

    if (snapshot.next && snapshot.next.length > 0) {
      // 既无 interrupt 又有未执行节点：理论上不可达，保守按失败处理
      throw new Error('图在未中断且未结束的状态停止');
    }

    await this.emitFinished(threadId, runId);
  }

  /** 流异常：先排除 interrupt 冒泡 / 取消，其余按运行失败落库并发 error 事件 */
  private async handleStreamError(
    err: unknown,
    graph: ReturnType<typeof this.buildGraph>,
    threadId: string,
    runId: string,
    config: RunnableConfig,
  ): Promise<void> {
    // interrupt 在个别版本可能以 bubble 形式冒出：以 checkpoint 状态为准
    try {
      const snapshot = (await graph.getState(config)) as IStateSnapshotShape;
      const pendingInterrupt = this.findInterrupt(snapshot);
      if (pendingInterrupt) {
        const value = (pendingInterrupt.value ?? {}) as { draft?: IAgentDraft };
        await this.emit(runId, AGENT_EVENT_TYPE.INTERRUPT, {
          type: 'approval_required',
          threadId,
          runId,
          draft: value.draft ?? null,
        });
        return;
      }
    } catch {
      // getState 失败时继续按错误处理
    }

    const run = await this.approval.getByThreadId(threadId).catch(() => null);
    if (run?.status === AGENT_RUN_STATUS.CANCELLED) {
      await this.emit(runId, AGENT_EVENT_TYPE.RUN_CANCELLED, {
        reason: run.reason ?? undefined,
        run,
      });
      return;
    }

    await this.handleRunFailure(threadId, runId, err);
  }

  private findInterrupt(
    snapshot: IStateSnapshotShape,
  ): IStateInterrupt | undefined {
    for (const task of snapshot.tasks ?? []) {
      const first = task.interrupts?.[0];
      if (first) return first;
    }
    return undefined;
  }

  /** 图运行结束：按 MySQL 权威状态发 run.completed / run.cancelled */
  private async emitFinished(threadId: string, runId: string): Promise<void> {
    const run = await this.approval.getByThreadId(threadId);
    if (run.status === AGENT_RUN_STATUS.CANCELLED) {
      await this.emit(runId, AGENT_EVENT_TYPE.RUN_CANCELLED, {
        reason: run.reason ?? undefined,
        run,
      });
      return;
    }
    await this.emit(runId, AGENT_EVENT_TYPE.RUN_COMPLETED, { run });
  }

  // ── 节点实现 ─────────────────────────────────────────────────────────────

  private async generateDraft(
    state: IAgentGraphState,
    config?: RunnableConfig,
  ): Promise<Partial<IAgentGraphState>> {
    const { draft, raw } = await this.qwen.generateDraft(state.prompt, config);

    await this.emit(state.runId, AGENT_EVENT_TYPE.MESSAGE_COMPLETED, {
      content: raw,
      node: 'generateDraft',
    });

    await this.approval.attachDraft(state.threadId, draft);
    return { draft };
  }

  private waitForApproval(state: IAgentGraphState): Partial<IAgentGraphState> {
    // interrupt() 会把图挂起，直到外部通过 Command({resume}) 恢复。
    // resume 的值就是这里 interrupt() 的返回值。
    const decision: unknown = interrupt({
      type: 'approval_required',
      runId: state.runId,
      threadId: state.threadId,
      draft: state.draft,
    });
    const { approved, reason } = decision as {
      approved: boolean;
      reason?: string;
    };

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

    await this.emit(state.runId, AGENT_EVENT_TYPE.TOOL_STARTED, {
      tool: AGENT_ACTION_TYPE.CREATE_POST_DRAFT,
      input: state.draft,
    });

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

      await this.approval.markExecuted(BigInt(state.runId), {
        postId: post.id.toString(),
      });

      await this.emit(state.runId, AGENT_EVENT_TYPE.TOOL_COMPLETED, {
        tool: AGENT_ACTION_TYPE.CREATE_POST_DRAFT,
        result: { postId: post.id.toString() },
      });

      return { postId: post.id.toString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.approval.markExecuted(BigInt(state.runId), undefined, message);

      await this.emit(state.runId, AGENT_EVENT_TYPE.TOOL_COMPLETED, {
        tool: AGENT_ACTION_TYPE.CREATE_POST_DRAFT,
        error: message,
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
      await this.approval.markExecuted(BigInt(runId), undefined, message);
      await this.emit(runId, AGENT_EVENT_TYPE.ERROR, { message });
    } catch (e) {
      this.logger.error(
        `记录运行失败状态失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  onModuleDestroy(): void {
    // RedisSaver 内部持有 redis client；交由进程退出时统一回收
    for (const controller of this.runners.values()) {
      controller.abort();
    }
    this.runners.clear();
    this.checkpointer = null;
    this.graph = null;
  }
}
