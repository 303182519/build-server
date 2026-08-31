import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConfig } from '@/config/configuration';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import { GithubConfig } from '@/config/configuration.interface';

// 从 GitHub 拿到的用户信息（已收窄成我们需要的字段）
export interface GithubUser {
  id: string; // GitHub 数字 id（转成字符串）
  login: string; // GitHub 用户名
  name: string | null;
  email: string | null;
}
/**
 * GitHub OAuth 的"对外通信层"——所有打 GitHub 的 HTTP 都在这里，方便测试时整体替换。
 * 业务逻辑（找/建用户、发本系统 token）在 AuthService.loginWithGithub。
 *
 * HTTP 客户端选型：Node 20+ 原生 fetch，不引入 axios。GitHub 三次往返（授权页是浏览器跳转，
 * 不走服务端）：换 token → 拉资料。两路调用都用同一套错误出口（OAUTH_EXCHANGE_FAILED），
 * 不把上游的 5xx / 网络异常透传给前端，避免泄露上游细节。
 */
@Injectable()
export class GithubOAuthProvider {
  // GitHub 授权码换 token 的端点
  private readonly tokenUrl = 'https://github.com/login/oauth/access_token';
  // GitHub 用户资料端点
  private readonly userUrl = 'https://api.github.com/user';

  constructor(private readonly configService: ConfigService) {}

  private get config(): GithubConfig {
    return getConfig(this.configService).github;
  }

  /** 是否配置了 GitHub OAuth（clientId + clientSecret 都有）。为空则禁用 GitHub 登录，不影响启动。 */
  isConfigured(): boolean {
    const { clientId, clientSecret } = this.config;
    return Boolean(clientId && clientSecret);
  }

  /**
   * 生成跳到 GitHub 授权页的 URL（第一步，浏览器直接访问）。
   * state 由 OAuthStateService 生成并存储，回调时一次性校验，防 CSRF。
   * scope 用 read:user + user:email：read:user 覆盖基础资料，user:email 兜底取邮箱
   * （GitHub 即使授权了，/user 也只在邮箱公开时返回，私有则仍为 null，符合 schema 允许 email 可空的设计）。
   */
  getAuthorizeUrl(state: string): string {
    const { clientId, callbackUrl } = this.config;
    const params = new URLSearchParams({
      client_id: clientId!,
      redirect_uri: callbackUrl!,
      scope: 'read:user user:email',
      state,
      allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * 第二步之一：用授权码换 GitHub access_token。
   * accept: application/json：GitHub 默认返回 form-urlencoded，显式要 JSON 才好解析。
   * 失败（GitHub 回 error / 网络 / 非 2xx）统一抛 OAUTH_EXCHANGE_FAILED，不暴露上游细节。
   */
  async exchangeCodeForToken(code: string): Promise<string> {
    const { clientId, clientSecret, callbackUrl } = this.config;
    let res: Response;
    try {
      res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId!,
          client_secret: clientSecret!,
          code,
          redirect_uri: callbackUrl!,
        }),
      });
    } catch {
      // 网络层异常（DNS / 连接超时...）：不区分原因，统一上游故障
      throw new ErrorException(ErrorExceptionCode.OAUTH_EXCHANGE_FAILED);
    }
    if (!res.ok) {
      throw new ErrorException(ErrorExceptionCode.OAUTH_EXCHANGE_FAILED);
    }
    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!data.access_token) {
      // code 已被用过 / 过期 / 与 redirect_uri 不符 等，统一按上游故障
      throw new ErrorException(ErrorExceptionCode.OAUTH_EXCHANGE_FAILED);
    }
    return data.access_token;
  }

  /**
   * 第二步之二：用 GitHub access_token 拉用户资料。
   * User-Agent + Authorization: token 是 GitHub API 的硬性要求，缺一个就 403。
   * 字段收窄到 GithubUser：只取我们要的 id/login/name/email，避免透传一堆用不上的字段。
   * email 为 null 是合法的（schema 允许），不在这里补救。
   */
  async fetchGithubUser(accessToken: string): Promise<GithubUser> {
    let res: Response;
    try {
      res = await fetch(this.userUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          // GitHub 要求带 UA，否则可能 403；随便写一个标识即可
          'User-Agent': 'build-server',
        },
      });
    } catch {
      throw new ErrorException(ErrorExceptionCode.OAUTH_EXCHANGE_FAILED);
    }
    if (!res.ok) {
      throw new ErrorException(ErrorExceptionCode.OAUTH_EXCHANGE_FAILED);
    }
    const data = (await res.json()) as {
      id: number;
      login: string;
      name: string | null;
      email: string | null;
    };
    return {
      id: String(data.id),
      login: data.login,
      name: data.name,
      email: data.email,
    };
  }
}
