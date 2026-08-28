import { AUTH_THROTTLE, REFRESH_TOKEN_KEY } from '@/common/constants/auth';
import { IsProduction } from '@/common/constants/environment';
import { Cookies } from '@/common/decorators/cookies.decorator';
import { Public } from '@/common/decorators/jwt-auth.decorator';
import { getConfig } from '@/config/configuration';
import { Body, Controller, Post, Res } from '@nestjs/common';
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
  AuthResponseDto,
  LogoutResponseDto,
  RefreshResponseDto,
} from './dto/auth-response.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly configService: ConfigService,
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

  private setRefreshTokenCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_TOKEN_KEY, refreshToken, {
      httpOnly: true,
      secure: IsProduction,
      maxAge: getConfig(this.configService).jwt.refreshExpiresIn * 1000,
    });
  }
}
