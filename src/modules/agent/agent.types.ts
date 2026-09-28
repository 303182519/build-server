export const AGENT_RUN_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type AgentRunStatus =
  (typeof AGENT_RUN_STATUS)[keyof typeof AGENT_RUN_STATUS];

export const AGENT_ACTION_TYPE = {
  CREATE_POST_DRAFT: 'create_post_draft',
} as const;

export type AgentActionType =
  (typeof AGENT_ACTION_TYPE)[keyof typeof AGENT_ACTION_TYPE];

export interface IAgentDraft {
  title: string;
  slug: string;
  content: string;
  tags: string[];
}

export interface IAgentRunView {
  id: string;
  threadId: string;
  userId: string;
  prompt: string;
  actionType: AgentActionType;
  status: AgentRunStatus;
  payload: IAgentDraft | null;
  decidedAt: Date | null;
  reason: string | null;
  executedAt: Date | null;
  result: { postId: string } | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ----------------------------------------------------------------------------
// Agent 流式事件模型
// ----------------------------------------------------------------------------
// 链路：LangGraph graph.stream() → Agent Event Layer → Redis Stream → SSE → Browser
//
// AgentEvent 是事件层的统一信封：
//   - eventId  事件全局唯一 ID（uuid），用于事件去重/追踪
//   - runId    所属运行（agent_approvals.id）
//   - sequence 同一 run 内严格递增的序号（跨实例由 Redis INCR 保证），用于丢包检测
//   - timestamp 事件产生时间（ms）
// 传输层（Redis Stream entry id / SSE id: 行）另有 transportId，支持断线续传。
// ----------------------------------------------------------------------------

export const AGENT_EVENT_TYPE = {
  RUN_STARTED: 'run.started',
  NODE_STARTED: 'node.started',
  NODE_COMPLETED: 'node.completed',
  MESSAGE_DELTA: 'message.delta',
  MESSAGE_COMPLETED: 'message.completed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  INTERRUPT: 'interrupt',
  ERROR: 'error',
  RUN_COMPLETED: 'run.completed',
  RUN_CANCELLED: 'run.cancelled',
} as const;

export type AgentEventType =
  (typeof AGENT_EVENT_TYPE)[keyof typeof AGENT_EVENT_TYPE];

export interface AgentEvent<T = unknown> {
  eventId: string;

  runId: string;

  type: AgentEventType;

  timestamp: number;

  data: T;

  sequence: number;
}

/** run.started：一次运行开始 */
export interface IAgentRunStartedData {
  threadId: string;
  actionType: AgentActionType;
  prompt: string;
}

/** node.started / node.completed：图节点生命周期 */
export interface IAgentNodeEventData {
  node: string;
}

/** message.delta：LLM 流式 token 分片 */
export interface IAgentMessageDeltaData {
  content: string;
  node?: string;
}

/** message.completed：LLM 完整输出（原始文本） */
export interface IAgentMessageCompletedData {
  content: string;
  node?: string;
}

/** tool.started：副作用工具开始执行 */
export interface IAgentToolStartedData {
  tool: AgentActionType;
  input?: unknown;
}

/** tool.completed：副作用工具执行结束（result / error 互斥） */
export interface IAgentToolCompletedData {
  tool: AgentActionType;
  result?: unknown;
  error?: string;
}

/** interrupt：图挂起，等待人工审批 */
export interface IAgentInterruptData {
  type: 'approval_required';
  threadId: string;
  runId: string;
  draft: IAgentDraft | null;
}

/** error：运行异常终止 */
export interface IAgentErrorData {
  message: string;
  node?: string;
}

/** run.completed：图运行结束（含审批拒绝/副作用成功或失败，终态以 run 视图为准） */
export interface IAgentRunCompletedData {
  run: IAgentRunView;
}

/** run.cancelled：运行被发起人取消 */
export interface IAgentRunCancelledData {
  reason?: string;
  run: IAgentRunView;
}

/** SSE 收到即关闭连接的终态事件 */
export const AGENT_TERMINAL_EVENT_TYPES: readonly AgentEventType[] = [
  AGENT_EVENT_TYPE.RUN_COMPLETED,
  AGENT_EVENT_TYPE.RUN_CANCELLED,
  AGENT_EVENT_TYPE.ERROR,
];

/**
 * Redis Stream 中的一条消息：transportId 是 Redis Stream entry id
 * （同时作为 SSE id: 行，浏览器断线重连时通过 Last-Event-ID 回放）。
 */
export interface IAgentStreamEntry {
  transportId: string;
  event: AgentEvent;
}

export interface IAgentGraphState {
  threadId: string;
  runId: string;
  userId: string;
  prompt: string;
  draft?: IAgentDraft;
  approved?: boolean;
  reason?: string;
  postId?: string;
  error?: string;
}
