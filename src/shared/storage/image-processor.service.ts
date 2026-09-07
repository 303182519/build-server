import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { ErrorException } from '../../common/exceptions/error.exception';
import { StorageExceptionCode } from '../../common/exceptions/storage.exception';
import { MIME_TO_EXT } from './storage.constants';
import { getConfig } from '@/config/configuration';

/** 处理后的图：新的字节流 + 元信息。 */
export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
  format: string;
}

/**
 * 图片尺寸硬上限（像素）：超过这个尺寸 sharp 解码会消耆大量内存（一张 20000×20000 RGBA ≈ 1.5GB）。
 * 这个上限和 coverMaxWidth 不同——后者是「归一化目标宽度」，这里是「拒绝处理的绝对上限」。
 */
const MAX_DIMENSION_PX = 10_000;

/**
 * ImageProcessorService —— 用 sharp 对上传图片做「核验 + 归一化」。
 *
 * 两件事，缺一不可：
 *
 * 1. **核验这是真的图**（不是被改了扩展名 / 改了 Content-Type 的别的文件）。
 *    只看 Content-Type / 扩展名是经典漏洞：攻击者把 a.php 改名 a.jpg、或把恶意脚本
 *    顶个 image/jpeg 头上传。sharp 读取时会解析真实像素结构——解析不出 width/height
 *    就不是合法图，直接拒。这一步把「信任浏览器报的 MIME」换成「信任文件真实字节」。
 *
 * 2. **归一化**：统一缩放到最大宽度、转成目标格式（默认 webp，体积/质量比 jpeg 更优）。
 *    好处：省带宽与存储；杜绝「上传 8000×8000 的图把列表页撑爆」；EXIF 自动旋正（手机竖拍不倒）。
 *
 * ★ 这一步在前端【不能省、但也不能只靠前端】：浏览器校验只是体验优化，绕过它直发
 *   multipart 的成本几乎为零。后端必须自己核验（纵深防御）。
 */
@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);

  constructor(private readonly configService: ConfigService) {}

  async processCover(buffer: Buffer): Promise<ProcessedImage> {
    // ① 读真实元信息——解析失败 = 不是图。
    const meta = await sharp(buffer)
      .metadata()
      .catch(() => null);
    if (!meta || !meta.width || !meta.height) {
      throw new ErrorException(StorageExceptionCode.INVALID_FILE);
    }

    // ② 尺寸硬上限：防止超大图解码时 OOM（像素结构合法但尺寸不合理）。
    if (meta.width > MAX_DIMENSION_PX || meta.height > MAX_DIMENSION_PX) {
      this.logger.warn(
        `图片尺寸超限：${meta.width}×${meta.height}（上限 ${MAX_DIMENSION_PX}px）`,
      );
      throw new ErrorException(StorageExceptionCode.INVALID_FILE);
    }

    // ③ 动画图提个日志：sharp 处理 GIF 只取第一帧，结果是静态图——这是预期行为，但留痕便于排查。
    if (meta.format === 'gif' && (meta.pages ?? 1) > 1) {
      this.logger.debug(
        `动画 GIF 只取第一帧作为封面：${meta.width}×${meta.height}，${meta.pages} 帧`,
      );
    }

    const { upload } = getConfig(this.configService);

    const maxWidth = upload.coverMaxWidth;
    const format = upload.coverFormat;

    // ④ 归一化：自动按 EXIF 旋正 → 限制最大宽（不放大）→ 转目标格式。
    const { data, info } = await sharp(buffer)
      .rotate() // 0 参数 = 按 EXIF Orientation 自动旋正
      .resize({ width: maxWidth, withoutEnlargement: true }) // 小图不放大
      .toFormat(format, { quality: 82 }) // 82 是 webp/jpeg 质量/体积的常见甜点
      .toBuffer({ resolveWithObject: true });

    const contentType = `image/${info.format}`;
    const ext = MIME_TO_EXT[contentType] ?? info.format;
    this.logger.debug(
      `封面处理：${meta.width}×${meta.height} ${meta.format} → ${info.width}×${info.height} ${info.format} (${buffer.length}→${data.length}B)`,
    );
    return {
      buffer: data,
      contentType,
      ext,
      width: info.width,
      height: info.height,
      format: info.format,
    };
  }
}
