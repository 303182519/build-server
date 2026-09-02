import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PrismaPostsRepository } from './repositories/prisma-posts.repository';
import { POSTS_REPOSITORY } from './repositories/posts.repository';

@Module({
  controllers: [PostsController],
  providers: [
    PostsService,
    // 仓储抽象层：业务层只依赖 PostsRepository 接口，实现可替换。
    { provide: POSTS_REPOSITORY, useClass: PrismaPostsRepository },
  ],
})
export class PostsModule {}
