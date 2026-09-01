import { Module } from '@nestjs/common';


import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PrismaPostsRepository } from './repositories/prisma-posts.repository';
import { POSTS_REPOSITORY } from './repositories/posts.repository';


@Module({
  controllers: [PostsController],
  providers: [
    PostsService,


    //   想切回内存版（比如临时演示）：把 InMemoryPostsRepository import 回来，
    //   再把下面这行的 useClass 换成它即可（类文件仍保留在 repositories/ 下）。
    { provide: POSTS_REPOSITORY, useClass: PrismaPostsRepository },
  ],
})
export class PostsModule {}
