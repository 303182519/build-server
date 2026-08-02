import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { BaseException } from '@/common/exceptions/base.exception';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    // throw new BaseException({
    //   message: '参数校验失败',
    //   status: 400,
    // });
    return this.appService.getHello();
  }
}
