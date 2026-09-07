import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { SaveInput, StoredFile, StorageService } from './storage.service';
import { getConfig } from '@/config/configuration';

/**
 * S3StorageService —— S3 兼容对象存储后端（AWS S3 / Cloudflare R2 / MinIO 共用同一套 API）。
 *
 * 为什么 S3 / R2 / MinIO 能用同一个客户端：
 *   它们都说 S3 协议（PutObject / GetObject / DeleteObject / HeadObject）。
 *   差异只是 endpoint 和「路径风格 vs 虚拟主机风格」：
 *     - AWS / R2：endpoint 留空或填区域端点，forcePathStyle=false（虚拟主机：<bucket>.s3...）。
 *     - MinIO / 自建：endpoint=http://localhost:9000，forcePathStyle=true（路径：localhost:9000/<bucket>/...）。
 *   一个 S3Client + 这两个旋钮，三个平台通吃。
 *
 * 和本地后端的差别（也是「选对象存储」的理由）：
 *   - 多实例共享：N 个 Pod 读写同一个 bucket，本地磁盘做不到
 *   - 无限容量 / 不占应用磁盘 / 可挂 CDN / 对象可直传（presigned URL）。
 *
 * ★ 它和 LocalStorageService 实现同一个抽象，业务零改动切换。
 */
@Injectable()
export class S3StorageService implements StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  readonly backend = 's3' as const;

  /** 写操作超时：图片上传可能较大，给 60s。 */
  private static readonly WRITE_TIMEOUT_MS = 60_000;
  /** 读 / 删除操作超时：轻量 HEAD/DELETE，15s 足够。 */
  private static readonly READ_TIMEOUT_MS = 15_000;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | undefined;
  private readonly endpoint: string | undefined;
  private readonly forcePathStyle: boolean;

  constructor(configService: ConfigService) {
    const { s3 } = getConfig(configService);
    this.bucket = s3.bucket;
    this.endpoint = s3.endpoint;
    this.publicBaseUrl = s3.publicBaseUrl;
    this.forcePathStyle = s3.forcePathStyle;

    this.client = new S3Client({
      region: s3.region,
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      // 幂等操作自动重试 3 次（网络抖动 / 5xx / 限速）。非幂等写操作 SDK 默认不重试。
      maxAttempts: 3,
    });
  }

  /** 凭证齐全即视为「可用」；真正的可达性在每次操作里检验（catch → 抛回调用方）。 */
  get available(): boolean {
    return Boolean(this.bucket);
  }

  async save(input: SaveInput): Promise<StoredFile> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.buffer,
          ContentType: input.contentType,
          // 封面图是静态资源、内容寻址（key 含 uuid），缓存久一点无妨——减轻回源。
          CacheControl: 'public, max-age=31536000, immutable',
        }),
        { abortSignal: AbortSignal.timeout(S3StorageService.WRITE_TIMEOUT_MS) },
      );
    } catch (e) {
      this.logger.error(
        `S3 PutObject 失败 key=${input.key}: ${(e as Error).message}`,
      );
      throw e; // 让调用方翻译成 STORAGE_FAILED
    }
    return {
      key: input.key,
      url: this.publicUrl(input.key),
      size: input.buffer.length,
      contentType: input.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(S3StorageService.READ_TIMEOUT_MS) },
      );
    } catch (e) {
      // delete 是 best-effort（孤儿清理），失败只记日志不抛——和抽象层契约一致。
      this.logger.warn(
        `S3 DeleteObject 失败（已忽略）key=${key}: ${(e as Error).message}`,
      );
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(S3StorageService.READ_TIMEOUT_MS) },
      );
      return true;
    } catch (e) {
      if (
        e instanceof S3ServiceException &&
        e.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      // 403 = 权限配置错误，必须暴露（error 级别），不能静默降级成「不存在」。
      if (
        e instanceof S3ServiceException &&
        e.$metadata?.httpStatusCode === 403
      ) {
        this.logger.error(
          `S3 HeadObject 权限不足 key=${key}——检查 bucket policy / IAM 权限`,
        );
        return false;
      }
      // 其它错误（网络 / 超时 / 未知）：warn 级别，降级成 false（best-effort）。
      this.logger.warn(
        `S3 HeadObject 异常（按不存在处理）key=${key}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * 对外 URL 的「基座」（不含 key）：
   *   - 配了 publicBaseUrl（推荐：CDN / R2 公开域名 / 自定义域）→ 用它。
   *   - 否则按 endpoint 拼 path-style：endpoint/bucket（R2 / MinIO 都这样可用）。
   *   ★ 统一 trim 末尾斜杠，防止 publicBaseUrl 配了尾部 / 时拼出双斜杠 URL。
   */
  private base(): string {
    if (this.publicBaseUrl) return this.publicBaseUrl.replace(/\/+$/, '');
    return `${this.endpoint ?? ''}/${this.bucket}`.replace(/\/+$/, '');
  }

  publicUrl(key: string): string {
    return `${this.base()}/${key}`;
  }

  keyFromPublicUrl(url: string): string | null {
    const prefix = `${this.base()}/`;
    return url.startsWith(prefix)
      ? decodeURIComponent(url.slice(prefix.length))
      : null;
  }
}
