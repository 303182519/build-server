import { PipeTransform, BadRequestException, Injectable } from '@nestjs/common';

@Injectable()
export class ParseSnowflakePipe implements PipeTransform<string, bigint> {
  transform(value: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('雪花ID格式错误，必须数字字符串');
    }
    try {
      return BigInt(value);
    } catch {
      throw new BadRequestException('雪花ID解析失败');
    }
  }
}
