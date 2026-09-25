import { IAgentSseEvent } from './agent.types';

/** 与 job-sse.util.ts 同构，但针对 Agent 事件类型，避免跨模块类型耦合 */
export const formatAgentSseEvent = (event: IAgentSseEvent): string => {
  return [
    `event: ${event.event}`,
    ...(event.id !== undefined ? [`id: ${event.id}`] : []),
    `data: ${JSON.stringify(event.data)}`,
    '',
    '',
  ].join('\n');
};
