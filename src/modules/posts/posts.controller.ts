import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
  ApiExceptionEnvelope,
} from '@/common/decorators/api-envelope.decorator';
import { Public } from '@/common/decorators/jwt-auth.decorator';
import { PostsService } from './posts.service';
import {
  PostListResponseDto,
  PostFeedResponseDto,
} from './dto/post-response.dto';
import { QueryPostDto } from './dto/query-post.dto';
import {
  PostExceptionCode,
  PostExceptionMap,
} from '@/common/exceptions/post.exception';

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

  // 游标分页。和下面的 search / debug 一样，静态路径必须放在 :id 前面，
  // 否则 'feed' 会被当成 :id 交给 ParseUUIDPipe → 400。
  @Get('feed')
  @Public()
  @ApiOperation({ summary: '信息流（cursor 分页）' })
  @ApiEnvelope(PostFeedResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.INVALID_CURSOR)
  feed(@Query() query: QueryPostDto) {
    return this.posts.feed(query);
  }
}
