import { AUTH_THROTTLE, REFRESH_TOKEN_KEY } from '@/common/constants/auth';
import { IsProduction } from '@/common/constants/environment';
import { Cookies } from '@/common/decorators/cookies.decorator';
import { Public } from '@/common/decorators/jwt-auth.decorator';
import { getConfig } from '@/config/configuration';
import { Body, Controller, Post, Res, Get, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenService } from './refresh-token.service';
import {
  AuthExceptionMap,
  AuthExceptionCode,
} from '@/common/exceptions/auth.exception';
import {
  UserExceptionMap,
  UserExceptionCode,
} from '@/common/exceptions/user.exception';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
  ApiExceptionEnvelope,
} from '@/common/decorators/api-envelope.decorator';
import {
  ErrorException,
  ErrorExceptionCode,
} from '@/common/exceptions/error.exception';
import {
  AuthResponseDto,
  LogoutResponseDto,
  RefreshResponseDto,
} from './dto/auth-response.dto';
import { GithubCallbackDto } from './dto/github-callback.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { GithubOAuthProvider } from './github-oauth.provider';
import { OAuthStateService } from './oauth-state.service';
import { OAuthTicketService } from './oauth-ticket.service';


@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly configService: ConfigService,
    private readonly github: GithubOAuthProvider,
    private readonly stateStore: OAuthStateService,
    private readonly ticketStore: OAuthTicketService,
  ) {}

  @ApiOperation({
    summary: '注册（bcrypt 哈希密码，返回 access + refresh）',
  })
  @ApiEnvelope(AuthResponseDto)
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiExceptionEnvelope(UserExceptionMap, UserExceptionCode.USER_ALREADY_EXISTS)
  @Throttle({ default: AUTH_THROTTLE.signup })
  @Public()
  @Post('register')
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.register(registerDto);

    this.setRefreshTokenCookie(res, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessExpiresAt,
      user: tokens.user,
    };
  }

  @ApiOperation({
    summary: '登录',
  })
  @ApiEnvelope(AuthResponseDto)
  @ApiExceptionEnvelope(AuthExceptionMap, AuthExceptionCode.INVALID_CREDENTIALS)
  @Throttle({ default: AUTH_THROTTLE.login })
  @Public()
  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.login(loginDto);

    this.setRefreshTokenCookie(res, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessExpiresAt,
      user: tokens.user,
    };
  }

  @ApiOperation({
    summary: '用 refresh 换新 access（轮换：旧 refresh 立即作废）',
  })
  @ApiEnvelope(RefreshResponseDto)
  @ApiExceptionEnvelope(
    AuthExceptionMap,
    AuthExceptionCode.INVALID_REFRESH_TOKEN,
  )
  @Throttle({ default: AUTH_THROTTLE.refreshToken })
  @Public()
  @Post('refresh-token')
  async refreshToken(
    @Cookies(REFRESH_TOKEN_KEY) refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens } = await this.refreshTokenService.rotate(refreshToken);

    this.setRefreshTokenCookie(res, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessExpiresAt,
    };
  }

  @ApiOperation({ summary: '登出（作废该 refresh token，幂等）' })
  @ApiEnvelope(LogoutResponseDto)
  @ApiBearerAuth()
  @Throttle({ default: AUTH_THROTTLE.logout })
  @Post('logout')
  logout(
    @Cookies(REFRESH_TOKEN_KEY) refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie(REFRESH_TOKEN_KEY);

    return this.authService.logout(refreshToken);
  }

  // ───────────────── GitHub OAuth（授权码模式）─────────────────
  // 第一步：浏览器访问本接口 → 我们生成 state（防 CSRF）并 302 跳到 GitHub 授权页。
  // 用 @Res() 直接发 302：这是少数手动控制响应的场景，不走统一 envelope。
  @Get('github')
  @ApiOperation({ summary: '发起 GitHub 登录（302 跳到 GitHub 授权页）' })
  @ApiExceptionEnvelope(
    AuthExceptionMap,
    AuthExceptionCode.OAUTH_NOT_CONFIGURED,
  )
  @Throttle({ default: AUTH_THROTTLE.login })
  @Public()
  async githubLogin(@Res() res: Response) {
    if (!this.github.isConfigured()) {
      // 没配 client id/secret：明确回 503，而不是跳一个一定会失败的 URL
      throw new ErrorException(ErrorExceptionCode.OAUTH_NOT_CONFIGURED);
    }
    const state = await this.stateStore.generate();
    res.redirect(this.github.getAuthorizeUrl(state));
  }

  // 第二步：GitHub 同意后带 code + state 回调到这里。
  // 校验 state → 换 GitHub token → 拉资料 → 建号/登录 → 把 token 包换成一次性 ticket 存 Redis，
  // 302 跳前端回调页（URL 只带 #ticket=xxx）。token 不进 URL，前端再 fetch exchange 兑换。
  @Get('github/callback')
  @ApiOperation({
    summary: 'GitHub 回调：校验 state → 换 token → 签发 ticket → 302 跳前端',
  })
  @ApiExceptionEnvelope(AuthExceptionMap, AuthExceptionCode.OAUTH_FAILED)
  @ApiExceptionEnvelope(
    AuthExceptionMap,
    AuthExceptionCode.OAUTH_STATE_INVALID,
  )
  @ApiExceptionEnvelope(
    AuthExceptionMap,
    AuthExceptionCode.OAUTH_EXCHANGE_FAILED,
  )
  @Throttle({ default: AUTH_THROTTLE.login })
  @Public()
  async githubCallback(@Query() query: GithubCallbackDto, @Res() res: Response) {
    if (query.error) {
      // 用户在 GitHub 点了"拒绝"。error_description 是 GitHub 的文案，不透传给前端
      // （统一用我们自己的 OAUTH_FAILED 文案，避免上游字符串直接暴露给 API 消费方）
      throw new ErrorException(ErrorExceptionCode.OAUTH_FAILED);
    }
    // state 必须存在、未用过、未过期——consume 是一次性的，挡住 CSRF 和重复回调
    if (
      !query.code ||
      !query.state ||
      !(await this.stateStore.consume(query.state))
    ) {
      throw new ErrorException(ErrorExceptionCode.OAUTH_STATE_INVALID);
    }
    const githubToken = await this.github.exchangeCodeForToken(query.code);
    const ghUser = await this.github.fetchGithubUser(githubToken);
    const tokens = await this.authService.loginWithGithub(ghUser);
    // ★ 关键：这里是浏览器顶层导航（GitHub 302 跳过来），不能 return JSON——浏览器会把
    // JSON 当页面渲染，前端 JS 没机会执行、token 也没人存。所以把 token 包换成一次性
    // ticket 存 Redis，只把 ticket 放 URL fragment 跳到前端页；前端再 fetch exchange 兑换。
    // refresh 不在这里种 cookie：回调是跨域跳转（GitHub→后端），种 cookie 受 SameSite 限制
    // 易失败；挪到 exchange（前端 fetch 同源、带 credentials）种更可靠。
    const ticket = await this.ticketStore.issue(JSON.stringify(tokens));
    res.redirect(this.buildFrontendCallbackUrl(ticket));
  }

  // 第三步：前端回调页读 location.hash 里的 ticket，fetch 本接口换真正的 token 包。
  // provider 无关——GitHub/微信/微博的回调最终都签发 ticket 到这里兑换，本接口零 provider 耦合。
  // 加新 provider 只动各自的 initiate + callback，不碰这里。
  @Post('exchange')
  @ApiOperation({ summary: '用 OAuth ticket 兑换 access token + user' })
  @ApiEnvelope(AuthResponseDto)
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiExceptionEnvelope(
    AuthExceptionMap,
    AuthExceptionCode.OAUTH_TICKET_INVALID,
  )
  @Throttle({ default: AUTH_THROTTLE.login })
  @Public()
  async oauthExchange(
    @Body() body: OAuthExchangeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const payload = await this.ticketStore.consume(body.ticket);
    if (!payload) {
      // ticket 不存在/已用过/已过期——一次性保证：重放和兑换超时都挡掉
      throw new ErrorException(ErrorExceptionCode.OAUTH_TICKET_INVALID);
    }
    const tokens = JSON.parse(payload) as {
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: number;
      user: unknown;
    };
    // refresh 现在才写 httpOnly cookie：exchange 是前端 fetch（同源、带 credentials），
    // cookie 能正常种下。
    this.setRefreshTokenCookie(res, tokens.refreshToken);
    return {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessExpiresAt,
      user: tokens.user,
    };
  }

  // 拼 OAuth 完成后跳到前端回调页的 URL：ticket 作为 query 参数拼到 hash 或 search 内。
  // 兼容 hash 路由（#/path?ticket=xxx）和 history 路由（/path?ticket=xxx）两种前端模式。
  // 不带 token / user：URL 会落进浏览器历史 / 崩溃报告 / 扩展，token 进 URL 泄露面大。
  // ticket 一次性 + 60s TTL，即便泄露也作废。前端解析 ticket 后立即兑换。
  private buildFrontendCallbackUrl(ticket: string): string {
    const { frontendRedirectUrl } = getConfig(this.configService).github;
    const url = new URL(frontendRedirectUrl);
    const ticketParam = `ticket=${encodeURIComponent(ticket)}`;
    if (url.hash) {
      // hash 路由模式：拼进 hash 内部，避免与原 hash 路由（#/about?type=c）冲突产生第二个 #
      const hashPath = url.hash.slice(1); // 去掉前导 #
      const sep = hashPath.includes('?') ? '&' : '?';
      url.hash = `${hashPath}${sep}${ticketParam}`;
    } else {
      // history 模式：拼进 search（/about?type=callback&ticket=xxx）
      const sep = url.search ? '&' : '?';
      url.search = `${url.search}${sep}${ticketParam}`;
    }
    console.log('buildFrontendCallbackUrl', url.toString());
    return url.toString();
  }

  private setRefreshTokenCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_TOKEN_KEY, refreshToken, {
      httpOnly: true,
      secure: IsProduction,
      sameSite: IsProduction ? 'lax' : 'none', // 开发环境跨域调试用 none，none必须搭配 secure:true
      domain: IsProduction ? 'baidu.com' : undefined,
      path: '/', // /api/auth/refresh
      maxAge: getConfig(this.configService).jwt.refreshExpiresIn * 1000,
    });
  }
}
