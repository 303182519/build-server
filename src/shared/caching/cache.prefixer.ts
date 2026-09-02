import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConfig } from '@/config/configuration';

/**
 * 统一前缀化工具。
 *
 * 缓存目录下存在两条 Redis 落盘路径：
 *   1. 走 cache-manager → Keyv → KeyvRedis（由 KeyvRedis 在 store 层自动加 namespace 前缀）
 *   2. 直接 REDIS_CLIENT 调用（HashCacheService / LoginAttemptService / RedisLockService）
 *
 * 第 2 条路径不会自动前缀化，需要由调用方手动 prefix。本工具把 namespace + separator
 * 集中收口，避免散落字符串拼接；namespace/separator 与 cache.module.ts 中 KeyvRedis
 * 实例同源（同一份 config），保证两条路径落盘格式一致：`${namespace}:${业务key}`。
 *
 * separator 固定为 ':'，与 cache.module.ts 中 KeyvRedis 的 keyPrefixSeparator 对齐。
 * 改 separator 必须同步改 cache.module.ts。
 */
@Injectable()
export class KeyPrefixer {
  private readonly namespace: string;
  private readonly separator = ':';

  constructor(configService: ConfigService) {
    const { redis } = getConfig(configService);
    this.namespace = redis.keyPrefix;
  }

  /** 业务 key → 落盘 key：`${namespace}:${key}` */
  prefix(key: string): string {
    return `${this.namespace}${this.separator}${key}`;
  }

  /** SCAN MATCH 模式：`${namespace}:${pattern}` */
  pattern(p: string): string {
    return `${this.namespace}${this.separator}${p}`;
  }
}
