import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class StartRunDto {
  @ApiProperty({
    description: '想让 Agent 起草的文章主题/诉求，会传给 Qwen 生成草稿',
    example: '写一篇关于 NestJS 依赖注入最佳实践的短文',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @Length(10, 500, { message: 'prompt 长度需在 10-500' })
  prompt!: string;
}
