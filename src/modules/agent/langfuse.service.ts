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
import { CacheService } from '@/shared/caching/cache.service';

/**
 * Langfuse 全链路观测服务（v5 OTel 架构）。
 *
 * 方案：
 * - 启动时注册 NodeTracerProvider + LangfuseSpanProcessor，OTel span 自动导出到 Langfuse。
 * - Agent 运行用 @langfuse/langchain 的 CallbackHandler 自动捕获 LLM 调用、工具调用、token 用量。
 * - trace id 串联：startRun 时用 startActiveObservation 创建根 span（即 trace 起点），
 *   记录其 SpanContext；resumeRun 时把该 SpanContext 作为父上下文，保证两次 graph.stream
 *   （生成草稿 → 审批 → 执行副作用）归属同一条 trace。
 * - 分布式支持：SpanContext 同时写入进程内 Map（一级缓存，免一次 Redis 往返）
 *   与 Redis（经 CacheService，多实例共享、重启不丢）；resume 落在另一台机器时
 *   本地 miss 会回源 Redis 回填。Redis 不可用/读不到时退化为独立 trace，不影响业务。
 *
 * 降级哲学（同 QwenService）：未配置 LANGFUSE_SECRET_KEY / PUBLIC_KEY 时不注册 provider，
 * OTel 走 no-op，CallbackHandler 仍可传入但不产生任何上报，零开销、不影响业务。
 */
@Injectable()
export class LangfuseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private provider: NodeTracerProvider | null = null;
  /**
   * threadId → 根 span 的 SpanContext（一级缓存，仅本进程可见）。
   * 权威副本在 Redis（traceContextKey），保证多实例 / 重启后续接同一 trace。
   */
  private readonly traceContexts = new Map<string, SpanContext>();

  /**
   * trace 上下文 Redis TTL：25 小时。
   * 与 checkpoint 的 24h 保留窗口对齐并留 1h 余量，避免 checkpoint 尚在而上下文先过期。
   */
  private static readonly TRACE_CONTEXT_TTL_SECONDS = 25 * 60 * 60;

  constructor(
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  /** trace 上下文的 Redis key（模块内部 key，namespace 前缀由 CacheService 统一叠加） */
  private traceContextKey(threadId: string): string {
    return `agent:trace:${threadId}`;
  }

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

        // 记录根 span 上下文，供 resumeRun 续接同一 trace。
        // 先持久化（本地 + Redis）再执行 fn：即使 fn 提前失败、
        // 或 resume 由另一台机器处理，也能读到父上下文。
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          const spanContext = activeSpan.spanContext();
          this.traceContexts.set(threadId, spanContext);
          await this.persistTraceContext(threadId, spanContext);
        }
        return fn();
      },
      { endOnExit: true },
    );
  }

  /**
   * 在已存在的 trace 上下文中执行 fn（用于 resumeRun）。
   * 先查进程内一级缓存，miss 时回源 Redis（覆盖多实例 / 进程重启）。
   * 两处都没有（TTL 过期 / checkpoint 已被清理），退化为无父上下文的独立 trace。
   */
  async withTraceContext<T>(
    threadId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.isEnabled()) return fn();

    const parentCtx = await this.loadTraceContext(threadId);
    if (!parentCtx) {
      this.logger.warn(
        `未找到 threadId=${threadId} 的 trace 上下文，resume 将产生独立 trace`,
      );
      return fn();
    }

    const ctx: Context = trace.setSpanContext(context.active(), parentCtx);
    return context.with(ctx, fn);
  }

  /** 终态清理 trace 上下文（本地 + Redis）。保持同步签名：清理失败由 TTL 兜底，不阻塞业务终态 */
  releaseTrace(threadId: string): void {
    this.traceContexts.delete(threadId);
    void this.cache.del(this.traceContextKey(threadId)).catch((err: unknown) => {
      this.logger.warn(
        `trace 上下文 Redis 清理失败（将由 TTL 回收）threadId=${threadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /** 持久化 SpanContext 到 Redis；观测链路故障永远不反噬业务，写入失败仅降级为仅本机可见 */
  private async persistTraceContext(
    threadId: string,
    spanContext: SpanContext,
  ): Promise<void> {
    try {
      await this.cache.set(
        this.traceContextKey(threadId),
        spanContext,
        LangfuseService.TRACE_CONTEXT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `trace 上下文写入 Redis 失败，仅本机可续接 threadId=${threadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 读取 SpanContext：进程内 Map 命中直接返回；miss 回源 Redis 并回填本地缓存 */
  private async loadTraceContext(
    threadId: string,
  ): Promise<SpanContext | undefined> {
    const local = this.traceContexts.get(threadId);
    if (local) return local;

    try {
      const stored = await this.cache.get<SpanContext>(
        this.traceContextKey(threadId),
      );
      if (stored && this.isValidSpanContext(stored)) {
        this.traceContexts.set(threadId, stored);
        return stored;
      }
    } catch (err) {
      this.logger.warn(
        `trace 上下文读取 Redis 失败 threadId=${threadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return undefined;
  }

  /** 校验反序列化结果是否为合法 W3C SpanContext（traceId 32 hex / spanId 16 hex），防止脏数据进入 OTel */
  private isValidSpanContext(value: unknown): value is SpanContext {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.traceId === 'string' &&
      /^[0-9a-f]{32}$/i.test(candidate.traceId) &&
      typeof candidate.spanId === 'string' &&
      /^[0-9a-f]{16}$/i.test(candidate.spanId) &&
      typeof candidate.traceFlags === 'number'
    );
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
    // 只清进程内一级缓存；Redis 副本保留（重启后本实例 / 其他实例仍可续接），由 TTL 回收
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
