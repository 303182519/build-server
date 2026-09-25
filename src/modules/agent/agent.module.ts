import { Module } from '@nestjs/common';
import { PostsModule } from '../posts/posts.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentGraphService } from './agent-graph.service';
import { AgentEventsService } from './agent-events.service';
import { ApprovalService } from './approval.service';
import { QwenService } from './qwen.service';

@Module({
  imports: [PostsModule], // 需要 PostsService 执行"创建文章草稿"副作用
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentGraphService,
    AgentEventsService,
    ApprovalService,
    QwenService,
  ],
})
export class AgentModule {}
