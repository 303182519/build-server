import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { ApiEnvelope } from '@/common/decorators/api-envelope.decorator';
import { Public } from '@/common/decorators/jwt-auth.decorator';
import { PostsService } from './posts.service';
import { PostListResponseDto } from './dto/post-response.dto';
import { QueryPostDto } from './dto/query-post.dto';

@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // ── 读接口：公开，无需登录 ────────────────────────────────────────
  @Get()
  @Public()
  @ApiOperation({ summary: '列表（offset 分页 + 过滤 + 排序）' })
  @ApiEnvelope(PostListResponseDto)
  findAll(@Query() query: QueryPostDto) {
    return this.posts.findAll(query);
  }
}
