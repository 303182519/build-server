import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
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
  // 否则 'feed' 会被当成 :id 交给 → 400。
  @Get('feed')
  @Public()
  @ApiOperation({ summary: '信息流（cursor 分页）' })
  @ApiEnvelope(PostFeedResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.INVALID_CURSOR)
  feed(@Query() query: QueryPostDto) {
    return this.posts.feed(query);
  }

  // 热门文章排行榜（Sorted Set）。Redis ZSET 不可用时自动回退到 DB 按 view_count。
  // ★ 静态路径，必须放在 :id 前面，否则 'trending' 会被 当成 id → 400。
  @Get('trending')
  @Public()
  @ApiOperation({ summary: '热门文章排行榜（按浏览数，ZSET 加速，DB 兜底）' })
  @ApiEnvelope(PostListResponseDto)
  trending(@Query('limit') rawLimit?: string) {
    // query string 一律是字符串：解析 + 钳制到 [1, 50]，非法值退回默认 10。
    const n = Number(rawLimit);
    const limit =
      Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 50) : 10;
    return this.posts.trending(limit);
  }

  // 故意放在 :id 前面，避免 'debug' 被 ParseUUIDPipe 当成参数尝试解析
  @Get('debug/boom')
  @Public()
  @ApiExcludeEndpoint() // 调试端点，不进对外文档
  boom() {
    return this.posts.triggerBoom();
  }
}
