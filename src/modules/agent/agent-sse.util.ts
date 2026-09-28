import { IAgentStreamEntry } from './agent.types';

/**
 * 格式化为 SSE 协议帧：
 *   - id:    Redis Stream entry id（浏览器自动作为 Last-Event-ID 断线续传）
 *   - event: AgentEventType（run.started / message.delta / ...）
 *   - data:  AgentEvent 完整信封（含 eventId / runId / sequence / timestamp / data）
 */
export const formatAgentSseEvent = (entry: IAgentStreamEntry): string => {
  return [
    `id: ${entry.transportId}`,
    `event: ${entry.event.type}`,
    `data: ${JSON.stringify(entry.event)}`,
    '',
    '',
  ].join('\n');
};
