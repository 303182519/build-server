import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  context,
  trace,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { CallbackHandler } from '@langfuse/langchain';
import { startActiveObservation } from '@langfuse/tracing';
import { getConfig } from '@/config/configuration';

/**
 * Langfuse 全链路观测服务（v5 OTel 架构）。
 *
 * 方案：
 * - 启动时注册 NodeTracerProvider + LangfuseSpanProcessor，OTel span 自动导出到 Langfuse。
 * - Agent 运行用 @langfuse/langchain 的 CallbackHandler 自动捕获 LLM 调用、工具调用、token 用量。
 * - trace id 串联：startRun 时用 startActiveObservation 创建根 span（即 trace 起点），
 *   记录其 SpanContext；resumeRun 时把该 SpanContext 作为父上下文，保证两次 graph.stream
 *   （生成草稿 → 审批 → 执行副作用）归属同一条 trace。
 *
 * 降级哲学（同 QwenService）：未配置 LANGFUSE_SECRET_KEY / PUBLIC_KEY 时不注册 provider，
 * OTel 走 no-op，CallbackHandler 仍可传入但不产生任何上报，零开销、不影响业务。
 */
@Injectable()
export class LangfuseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private provider: NodeTracerProvider | null = null;
  /** threadId → 根 span 的 SpanContext，供 resumeRun 续接同一 trace */
  private readonly traceContexts = new Map<string, SpanContext>();

  constructor(private readonly configService: ConfigService) {}

  /** 观测是否启用（密钥齐全才启用） */
  isEnabled(): boolean {
    const { langfuse } = getConfig(this.configService);
    return Boolean(langfuse.secretKey && langfuse.publicKey);
  }

  /** 模块加载时注册 OTel Provider（仅启用时） */
  onModuleInit(): void {
    if (!this.isEnabled() || this.provider) return;

    const { langfuse } = getConfig(this.configService);
    try {
      this.provider = new NodeTracerProvider({
        spanProcessors: [
          new LangfuseSpanProcessor({
            publicKey: langfuse.publicKey,
            secretKey: langfuse.secretKey,
            baseUrl: langfuse.baseUrl,
          }),
        ],
      });
      this.provider.register();
      this.logger.log('Langfuse OTel SpanProcessor 已注册');
    } catch (err) {
      this.logger.warn(
        `Langfuse OTel 注册失败，观测已禁用: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.provider = null;
    }
  }

  /**
   * 创建一次 Agent 运行的根观测（trace 起点），并在其上下文中执行 fn。
   * fn 内部的所有 CallbackHandler 观测（LLM/工具/链）都会挂到该 trace 下。
   * 根 span 的 SpanContext 会被缓存，供 resumeRun 续接。
   */
  async startTrace<T>(
    threadId: string,
    params: {
      input: unknown;
      userId?: string;
      metadata?: Record<string, unknown>;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled()) return fn();

    return startActiveObservation(
      'agent-run',
      async (obs) => {
        obs.update({
          input: params.input,
          metadata: params.metadata,
          ...(params.userId ? { userId: params.userId } : {}),
        });

        // 记录根 span 上下文，供 resumeRun 续接同一 trace
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          this.traceContexts.set(threadId, activeSpan.spanContext());
        }
        return fn();
      },
      { endOnExit: true },
    );
  }

  /**
   * 在已存在的 trace 上下文中执行 fn（用于 resumeRun）。
   * 若未找到缓存的 SpanContext（跨进程/重启），退化为无父上下文的独立 trace。
   */
  async withTraceContext<T>(
    threadId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled()) return fn();

    const parentCtx = this.traceContexts.get(threadId);
    if (!parentCtx) {
      this.logger.warn(
        `未找到 threadId=${threadId} 的 trace 上下文，resume 将产生独立 trace`,
      );
      return fn();
    }

    const ctx: Context = trace.setSpanContext(context.active(), parentCtx);
    return context.with(ctx, fn);
  }

  /** 终态清理 trace 上下文缓存 */
  releaseTrace(threadId: string): void {
    this.traceContexts.delete(threadId);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      // shutdown 内部 flush 所有 pending spans
      await this.provider?.shutdown();
    } catch (err) {
      this.logger.warn(
        `Langfuse OTel shutdown 异常: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.provider = null;
    this.traceContexts.clear();
  }

  /**
   * 创建一个绑定当前运行的 Langfuse CallbackHandler。
   * 需传入 graph.stream 的 callbacks 数组中，自动捕获 LLM/工具/链调用。
   */
  createHandler(params?: {
    userId?: string;
    metadata?: Record<string, unknown>;
  }): CallbackHandler {
    return new CallbackHandler({
      userId: params?.userId,
      traceMetadata: params?.metadata,
    });
  }
}
