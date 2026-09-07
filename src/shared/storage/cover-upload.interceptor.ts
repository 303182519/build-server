import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import multer, { MulterError } from 'multer';
import { Observable } from 'rxjs';
import { ErrorException } from '@/common/exceptions/error.exception';
import { StorageExceptionCode } from '@/common/exceptions/storage.exception';
import { ALLOWED_IMAGE_MIME } from './storage.constants';
import { getConfig } from '@/config/configuration';

/**
 * CoverUploadInterceptor —— 封面图上传的 multer 解析层。
 *
 * 职责单一：把 multipart/form-data 缓冲到内存（memoryStorage），
 * 在缓冲开始前做 MIME 白名单校验（fileFilter），在缓冲结束后做大小校验。
 *
 * 为什么不直接用 @nestjs/platform-express 的 FileInterceptor：
 *   - 需要配置驱动的 limits（从环境变量读取 maxBytes）
 *   - 需要在 fileFilter 阶段就拦截非法 MIME，而不是等缓冲完再判断
 *   - 需要把 multer 内部错误翻译成项目统一的 ErrorException 体系
 *
 * 两层校验各挡一种攻击：
 *   - fileFilter（MIME 白名单）：在缓冲开始前拒绝，避免恶意文件占用内存
 *   - sharp（ImageProcessorService）：解析真实像素结构，防改扩展名 / Content-Type 的伪造
 */
@Injectable()
export class CoverUploadInterceptor implements NestInterceptor {
  private readonly upload: ReturnType<typeof multer>;

  constructor(private readonly configService: ConfigService) {
    const { upload } = getConfig(this.configService);

    this.upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: upload.maxBytes },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_MIME.has(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('UNSUPPORTED_MEDIA_TYPE'));
        }
      },
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const req = ctx.getRequest();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = ctx.getResponse();

    // multer 单文件解析，字段名 'file' 与 Controller @UploadedFile() 对应。
    const handler = this.upload.single('file');

    return new Observable((subscriber) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      handler(req, res, (err: unknown) => {
        if (err) {
          subscriber.error(this.translateError(err));
          subscriber.complete();
          return;
        }
        // multer 解析成功，继续执行后续管道 / Controller 方法
        next.handle().subscribe(subscriber);
      });
    });
  }

  /**
   * 把 multer 内部错误翻译成项目统一的 ErrorException。
   *
   * 错误分类：
   *   - LIMIT_FILE_SIZE：文件超过配置上限 → UPLOAD_TOO_LARGE (413)
   *   - 非 MulterError 且 message 为 'UNSUPPORTED_MEDIA_TYPE'：fileFilter 拒绝 → UNSUPPORTED_MEDIA_TYPE (415)
   *   - 其它 MulterError：意外的解析失败 → INVALID_FILE (422)
   */
  private translateError(err: unknown): ErrorException {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return new ErrorException(StorageExceptionCode.UPLOAD_TOO_LARGE);
      }
      return new ErrorException(StorageExceptionCode.INVALID_FILE);
    }
    if (err instanceof Error && err.message === 'UNSUPPORTED_MEDIA_TYPE') {
      return new ErrorException(StorageExceptionCode.UNSUPPORTED_MEDIA_TYPE);
    }
    return new ErrorException(StorageExceptionCode.INVALID_FILE);
  }
}
