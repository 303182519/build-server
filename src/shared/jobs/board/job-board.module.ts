import { Module } from '@nestjs/common';
import { AppConfigModule } from '@/config/config.module';
import { JobQueueModule } from '../queue/job-queue.module';
import { JobBoardService } from './job-board.service';

/**
 * Bull Board 任务监控面板模块。
 *
 * 接入方式：
 *   - 由 JobsModule（或 AppModule）import，提供 JobBoardService
 *   - main.ts 从 DI 容器取出 JobBoardService，调用 setupMiddleware()
 *     通过 app.use() 在 NestJS 路由之前挂载 Express 中间件
 *
 * 安全边界：
 *   - 面板路由完全绕过 NestJS 全局 Guard 链（JwtAuthGuard / PermissionGuard / ThrottlerGuard）
 *   - 认证由 JobBoardService 内部中间件独立负责
 *   - 支持 enabled / authType / readOnly 三项配置，按环境灵活控制
 */
@Module({
  imports: [AppConfigModule, JobQueueModule],
  providers: [JobBoardService],
  exports: [JobBoardService],
})
export class JobBoardModule {}
