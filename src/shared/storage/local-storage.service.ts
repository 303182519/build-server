import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ErrorException } from '@/common/exceptions/error.exception';
import { StorageExceptionCode } from '@/common/exceptions/storage.exception';
import { getConfig } from '@/config/configuration';
import type { SaveInput, StoredFile, StorageService } from './storage.service';

/**
 * LocalStorageService —— 把字节写到本地磁盘，默认后端（零配置可用）。
 *
 * 为什么默认是它：
 *   - 不依赖任何外部对象存储；测试、本地开发、CI 都能跑。
 *   - 对外 URL 形如 /uploads/covers/<id>/<uuid>.webp，由 main.ts 挂的 express static 提供服务。
 *
 * 和 S3StorageService 实现同一个 StorageService 抽象——业务零感知后端差异。
 */
@Injectable()
export class LocalStorageService implements StorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  readonly backend = 'local' as const;
  readonly available = true; // 本地磁盘恒可用

  /** 写入根目录（相对 cwd 解析成绝对路径）。 */
  private readonly root: string;
  /** 对外 URL 前缀，和 main.ts 里 useStaticAssets 的 prefix 对齐。 */
  private readonly publicPrefix: string;

  constructor(configService: ConfigService) {
    const { storage } = getConfig(configService);

    this.root = resolve(process.cwd(), storage.localDir);
    this.publicPrefix = storage.publicPrefix;
  }

  async save(input: SaveInput): Promise<StoredFile> {
    const abs = this.safeAbs(input.key);
    if (!abs) {
      // 即便 key 是内部生成的，防御也放在边界上——纵深防御不依赖「调用方一定传安全值」。
      throw new ErrorException(StorageExceptionCode.INVALID_FILE);
    }
    // 确保父目录存在（key 可能是 covers/<id>/<file> 这种多层）。
    await fs.mkdir(dirname(abs), { recursive: true });
    // 原子写入：先写临时文件，再 rename。防止进程崩溃 / 磁盘满留下半写损坏文件。
    // 同文件系统下 rename 是原子操作，读者要么看到旧文件要么看到完整新文件。
    const tmp = `${abs}.tmp.${randomUUID()}`;
    try {
      await fs.writeFile(tmp, input.buffer);
      await fs.rename(tmp, abs);
    } catch (e) {
      // 写入失败时清理临时文件（best-effort）
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return {
      key: input.key,
      url: this.publicUrl(input.key),
      size: input.buffer.length,
      contentType: input.contentType,
    };
  }

  async delete(key: string): Promise<void> {
    const abs = this.safeAbs(key); // 解析后必须仍在 root 内（防目录穿越）
    if (!abs) return; // 非法 key：直接忽略，删除本就是 best-effort
    await fs.rm(abs, { force: true }); // force: 不存在也不抛
  }

  async exists(key: string): Promise<boolean> {
    const abs = this.safeAbs(key);
    if (!abs) return false;
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(key: string): string {
    return `${this.publicPrefix}/${key}`;
  }

  keyFromPublicUrl(url: string): string | null {
    const prefix = `${this.publicPrefix}/`;
    return url.startsWith(prefix)
      ? decodeURIComponent(url.slice(prefix.length))
      : null;
  }

  /**
   * 把 key 解析成绝对路径，并校验它【仍然落在 root 内】。
   * 即便 key 是我们生成的（uuid），这层校验也是删除路径上的必做项——
   * 任何把用户输入当文件名拼路径的代码，都要防 `../` 目录穿越（path traversal）：
   * resolve 会把 `a/../../etc/passwd` 规整成 root 之外的路径，越界就拒。
   */
  private safeAbs(key: string): string | null {
    const abs = resolve(this.root, key);
    if (abs === this.root || abs.startsWith(this.root + '/')) return abs;
    this.logger.warn(`拒绝访问 root 外的路径：${key}`);
    return null;
  }
}
