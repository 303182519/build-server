import {
  Controller,
  Get,
  Query,
  Param,
  Post,
  Delete,
  Body,
  Patch,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { ApiOperation, ApiExcludeEndpoint, ApiParam } from '@nestjs/swagger';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
  ApiExceptionEnvelope,
} from '@/common/decorators/api-envelope.decorator';
import { Public, UserInfo } from '@/common/decorators/jwt-auth.decorator';
import { PostsService } from './posts.service';
import {
  PostListResponseDto,
  PostFeedResponseDto,
  PostResponseDto,
  DeletedResponseDto,
} from './dto/post-response.dto';
import { QueryPostDto } from './dto/query-post.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';

import {
  PostExceptionCode,
  PostExceptionMap,
} from '@/common/exceptions/post.exception';
import { ParseSnowflakePipe } from '@/common/pipes/parse-snowflake.pipe';

// 路径参数 :id 的统一文档
const idParam = ApiParam({
  name: 'id',
  description: '文章 id',
});

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

  // 故意放在 :id 前面，避免 'debug' 被当成参数尝试解析
  @Get('debug/boom')
  @Public()
  @ApiExcludeEndpoint() // 调试端点，不进对外文档
  boom() {
    return this.posts.triggerBoom();
  }

  // 校验路径参数格式 不会进 Service
  @Get(':id')
  @ApiOperation({ summary: '按 id 查单篇' })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_NOT_FOUND)
  findOne(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.posts.findOne(id.toString());
  }

  @Post()
  @ApiOperation({ summary: '创建文章（需登录，作者=当前用户）' })
  @ApiEnvelope(PostResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.SLUG_TAKEN)
  create(@Body() dto: CreatePostDto, @UserInfo() user: User) {
    return this.posts.create(dto, user.id.toString());
  }

  // 浏览计数 +1（原子自增，无需锁）。公开——匿名访客也能贡献浏览数。
  @Post(':id/view')
  @Public()
  @ApiOperation({ summary: '浏览计数 +1（原子自增）' })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_NOT_FOUND)
  incrementView(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.posts.incrementView(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '局部更新（需登录 + 作者本人或 SuperAdmin）',
    description:
      '带 `version` 即做乐观锁；不带则 last-write-wins。每次成功更新自增 version 并留一条修订。',
  })
  @idParam
  @ApiEnvelope(PostResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_NOT_FOUND)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_FORBIDDEN)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_ARCHIVED)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.SLUG_TAKEN)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.VERSION_CONFLICT)
  update(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() dto: UpdatePostDto,
    @UserInfo() user: User,
  ) {
    return this.posts.update(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除文章（需登录 + 作者本人或 SuperAdmin）' })
  @idParam
  @ApiEnvelope(DeletedResponseDto)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_FORBIDDEN)
  @ApiExceptionEnvelope(PostExceptionMap, PostExceptionCode.POST_NOT_FOUND)
  remove(@Param('id', ParseSnowflakePipe) id: bigint, @UserInfo() user: User) {
    return this.posts.remove(id, user);
  }
}
