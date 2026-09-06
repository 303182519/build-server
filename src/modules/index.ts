import { AuthModule } from './auth/auth.module';
import { PostsModule } from './posts/posts.module';
import { BackgroundTasksModule } from './background-tasks/background-tasks.module';
import { ScheduledTasksModule } from './scheduled-tasks/scheduled-tasks.module';

export const modules = [
  AuthModule,
  PostsModule,
  BackgroundTasksModule,
  ScheduledTasksModule,
];
