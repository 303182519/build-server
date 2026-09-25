export const AGENT_RUN_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
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

export const AGENT_SSE_EVENT = {
  SNAPSHOT: 'agent.snapshot',
  DRAFT_READY: 'agent.draft_ready',
  DECIDED: 'agent.decided',
  COMPLETED: 'agent.completed',
  FAILED: 'agent.failed',
} as const;

export type AgentSseEventName =
  (typeof AGENT_SSE_EVENT)[keyof typeof AGENT_SSE_EVENT];

export interface IAgentSseEvent {
  id?: string;
  event: AgentSseEventName;
  data: IAgentRunView;
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
