import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

// POST /auth/oauth/exchange 的 body：用 OAuth 回调签发的一次性 ticket 兑换真正的 token 包。
// ticket 来自回调 302 跳转 URL 的 #ticket=xxx，前端回调页读 location.hash 取到后立即兑换。
export class OAuthExchangeDto {
  @ApiProperty({ description: 'OAuth 回调签发的一次性 ticket' })
  @IsString()
  @IsNotEmpty()
  ticket!: string;
}
