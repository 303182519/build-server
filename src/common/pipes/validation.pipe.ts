import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
  Type,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// 提醒一下，你不必自己构建通用验证管道，因为 ValidationPipe 由 Nest 开箱即用。
// 下面只是个例子： https://xiguadev.com/node-60days/day-18
@Injectable()
export class ValidationPipe<T> implements PipeTransform<T> {
  async transform(value: T, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.toValidate(metatype)) {
      return value;
    }

    // plainToInstance(目标类, 普通对象)：把一个普通 JSON 对象，转换成目标类的实例对象。
    const object = plainToInstance(metatype, value) as object;
    const errors = await validate(object);

    if (errors.length > 0) {
      throw new BadRequestException('参数验证失败!');
    }

    return value;
  }

  private toValidate(metatype: Type<any>): boolean {
    const types: Type<any>[] = [String, Boolean, Number, Array, Object];

    return !types.includes(metatype);
  }
}
