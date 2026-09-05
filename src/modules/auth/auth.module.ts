import { AppConfigModule } from '@/config/config.module';
import { getConfig } from '@/config/configuration';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GithubOAuthProvider } from './github-oauth.provider';
import { OAuthStateService } from './oauth-state.service';
import { OAuthTicketService } from './oauth-ticket.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtAuthStrategy } from './strategies/jwt-auth.strategy';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      useFactory: (configService: ConfigService) => {
        const { jwt } = getConfig(configService);
        return {
          secret: jwt.secret,
          signOptions: { expiresIn: jwt.accessExpiresIn },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  // GithubOAuthProvider 用 ConfigService（全局）；
  // OAuthStateService / OAuthTicketService 用 REDIS_CLIENT（由全局 RedisCacheModule 提供，不在本模块 imports）。
  providers: [
    AuthService,
    JwtAuthStrategy,
    RefreshTokenService,
    GithubOAuthProvider,
    OAuthStateService,
    OAuthTicketService,
  ],
  exports: [RefreshTokenService],
})
export class AuthModule {}
