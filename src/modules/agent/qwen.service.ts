import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getConfig } from '@/config/configuration';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { IAgentDraft } from './agent.types';

/** 让 LLM 按固定 JSON 结构返回文章草稿 */
const DRAFT_SYSTEM_PROMPT = `你是一名技术博客作者。根据用户的诉求，输出一篇可发布的文章草稿。
必须且只能输出 JSON，结构如下：
{
  "title": "文章标题（20 字以内）",
  "slug": "url-slug（小写字母/数字/连字符，3-60 字符）",
  "content": "正文 markdown（至少 10 个字符）",
  "tags": ["标签1", "标签2"]
}
不要输出任何其他文字、解释或代码块标记。`;

@Injectable()
export class QwenService {
  private readonly logger = new Logger(QwenService.name);
  private model: ChatOpenAI | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 惰性初始化 LLM 客户端；未配置 apiKey / baseUrl 时返回 null，
   * 由调用方决定降级或抛 503（参照 GitHub OAuth 的 disable 语义）。
   */
  private getModel(): ChatOpenAI {
    if (this.model) return this.model;

    const { qwen } = getConfig(this.configService);
    if (!qwen.apiKey || !qwen.baseUrl) {
      throw new ErrorException(ErrorExceptionCode.AGENT_NOT_CONFIGURED);
    }

    this.model = new ChatOpenAI({
      apiKey: qwen.apiKey,
      model: qwen.model,
      configuration: {
        baseURL: qwen.baseUrl,
      },
      temperature: 0.7,
      maxTokens: 2000,
      timeout: 30_000,
    });
    return this.model;
  }

  /** 判断 Agent 功能是否可用 */
  isEnabled(): boolean {
    const { qwen } = getConfig(this.configService);
    return Boolean(qwen.apiKey && qwen.baseUrl);
  }

  /**
   * 调用 Qwen 生成文章草稿；失败时抛 ErrorException。
   *
   * 透传 LangGraph 节点的 RunnableConfig：其中包含 graph.stream(streamMode:'messages')
   * 注入的 StreamMessagesHandler 回调，model.invoke 内部仍以流式执行，token 分片
   * 会被图运行循环拦截并转成 message.delta 事件；signal 也随 config 透传，
   * 支持 run 取消时中断 LLM 请求。
   */
  async generateDraft(
    prompt: string,
    config?: RunnableConfig,
  ): Promise<{ draft: IAgentDraft; raw: string }> {
    const model = this.getModel();

    let raw: string;
    try {
      const response = await model.invoke(
        [
          { role: 'system', content: DRAFT_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        config,
      );
      raw = typeof response.content === 'string' ? response.content : '';
    } catch (err) {
      this.logger.error(
        `Qwen 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ErrorException(ErrorExceptionCode.GRAPH_INTERRUPT_FAILED);
    }

    return { draft: this.parseDraft(raw), raw };
  }

  /**
   * 解析 LLM 输出为 IAgentDraft；格式异常视为 LLM 调用失败
   */
  private parseDraft(raw: string): IAgentDraft {
    // 剥离可能的 markdown 代码块包裹
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      this.logger.error(`Qwen 返回非 JSON: ${cleaned.slice(0, 200)}`);
      throw new ErrorException(ErrorExceptionCode.GRAPH_INTERRUPT_FAILED);
    }

    const draft = parsed as Partial<IAgentDraft>;
    if (
      typeof draft.title !== 'string' ||
      draft.title.length === 0 ||
      typeof draft.slug !== 'string' ||
      !/^[a-z0-9-]+$/.test(draft.slug) ||
      typeof draft.content !== 'string' ||
      draft.content.length < 10 ||
      !Array.isArray(draft.tags) ||
      draft.tags.some((t) => typeof t !== 'string')
    ) {
      this.logger.error(`Qwen 草稿格式非法: ${cleaned.slice(0, 200)}`);
      throw new ErrorException(ErrorExceptionCode.GRAPH_INTERRUPT_FAILED);
    }

    return {
      title: draft.title,
      slug: draft.slug,
      content: draft.content,
      tags: draft.tags,
    };
  }
}
