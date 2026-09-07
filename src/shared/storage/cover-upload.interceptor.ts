import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
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
 * 上传并发信号量：限制同时进行的文件上传数，防止大量并发上传把内存吃满。
 *
 * 为什么需要它：
 *   multer.memoryStorage() 把每个文件完整缓冲到内存。如果 100 个用户同时上传 5MB 文件，
 *   瞬间需要 ~500MB 内存。信号量把并发数控制在合理范围，超出的请求排队等待；
 *   等待超时则快速拒绝（503），避免客户端无限挂起。
 */
class UploadSemaphore {
  private available: number;
  private readonly queue: Array<{
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueueSize: number,
  ) {
    this.available = maxConcurrency;
  }

  /**
   * 尝试获取许可。有空闲槽位则立即返回；否则排队等待。
   * 队列满或等待超时则抛异常。
   */
  async acquire(timeoutMs: number): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    // 队列也满了——快速拒绝，不让客户端无限等。
    if (this.queue.length >= this.maxQueueSize) {
      throw new ErrorException(StorageExceptionCode.TOO_MANY_UPLOADS);
    }
    // 排队等待，带超时保护。
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时：从队列移除自已，拒绝请求。
        const idx = this.queue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new ErrorException(StorageExceptionCode.TOO_MANY_UPLOADS));
      }, timeoutMs);
      this.queue.push({ resolve, timer });
    });
  }

  /** 归还许可：如果有等待者则唤醒第一个，否则槽位 +1。 */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.available++;
    }
  }
}

/** 最大并发上传数：5 个同时上传，每个最大 5MB → 峰值内存 ~25MB，可控。 */
const MAX_CONCURRENT_UPLOADS = 5;
/** 等待队列上限：防止慢上传堆积导致队列无限增长。 */
const MAX_UPLOAD_QUEUE = 20;
/** 排队等待超时：30s 内拿不到许可就拒绝。 */
const UPLOAD_WAIT_TIMEOUT_MS = 30_000;

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
  private readonly logger = new Logger(CoverUploadInterceptor.name);
  private readonly upload: ReturnType<typeof multer>;
  private readonly semaphore = new UploadSemaphore(
    MAX_CONCURRENT_UPLOADS,
    MAX_UPLOAD_QUEUE,
  );

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
      void (async () => {
        // ① 获取并发许可：超限则排队等待，超时 / 队列满则 503。
        try {
          await this.semaphore.acquire(UPLOAD_WAIT_TIMEOUT_MS);
        } catch (e) {
          this.logger.warn(
            `上传并发已满（${MAX_CONCURRENT_UPLOADS}），拒绝请求`,
          );
          subscriber.error(e);
          subscriber.complete();
          return;
        }

        try {
          // ② multer 解析文件（受信号量保护，同时最多 MAX_CONCURRENT_UPLOADS 个在缓冲）。
          await new Promise<void>((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            handler(req, res, (err: unknown) => {
              if (err) {
                reject(this.translateError(err));
              } else {
                resolve();
              }
            });
          });

          // ③ multer 解析成功，继续执行后续管道 / Controller 方法。
          next.handle().subscribe(subscriber);
        } catch (e) {
          subscriber.error(e);
          subscriber.complete();
        } finally {
          // ④ 归还许可——无论成功 / 失败 / 取消，都必须释放，否则后续上传会永久阻塞。
          this.semaphore.release();
        }
      })();
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
