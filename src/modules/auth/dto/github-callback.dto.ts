import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// GitHub 回调带的 query。成功是 code + state；用户拒绝授权则是 error + error_description。
// 都设可选、在 handler 里判，因为两种情况二选一。
export class GithubCallbackDto {
  @ApiPropertyOptional({ description: '授权码' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ description: '防 CSRF 的 state，须与发起时一致' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: '用户拒绝授权时 GitHub 会带 error' })
  @IsOptional()
  @IsString()
  error?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  error_description?: string;

  // GitHub 按 OAuth 2.0 RFC 9207 在回调里带的 issuer 标识（固定为 https://github.com/login/oauth）。
  // 全局 ValidationPipe 开了 forbidNonWhitelisted，未声明字段会被直接 400，所以必须白名单。
  // 我们不消费它（state 已经够防 CSRF 了），仅声明放过校验。
  @ApiPropertyOptional({
    description: 'GitHub issuer 标识（RFC 9207），本服务不消费',
  })
  @IsOptional()
  @IsString()
  iss?: string;
}
