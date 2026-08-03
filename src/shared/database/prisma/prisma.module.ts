import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global() 一旦加上，注册之后全项目随处可用，无需重复导入
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService], // 必须导出！外部模块才能注入
})
export class PrismaModule {}
