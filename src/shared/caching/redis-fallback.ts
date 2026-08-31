import { Logger } from '@nestjs/common';
import type { RedisClientType } from '@keyv/redis';

/**
 * Redis 可选层的统一降级入口。
 *
 * 「client 未配置」（redis 为 null）和「运行期故障」（断连 / 超时等导致的 reject）
 * 是两种不同的故障，但对调用方来说是同一个结果：这层保护/缓存不可用，按 fallback 降级。
 * 两者在这里收口，调用点不再各自写 null 判断 + try/catch + 日志样板。
 *
 * fallback 必须由调用点显式给出，因为降级语义是业务决策：
 *   缓存读   → undefined/null（当作 miss）
 *   计数器   → 0 / no-op
 *   登录锁定 → fail-open（isLocked=false，宁可少一层防护也不挡登录）
 *   分布式锁 → null（按"没抢到"处理，绝不能假装抢到）
 * 正确性敏感、不许静默降级的操作（如 rotateRefreshToken）刻意不走这里，让错误上抛。
 */
export const withRedis = async <T>(
  redis: RedisClientType | null,
  op: (client: RedisClientType) => Promise<T>,
  fallback: T,
  context: string,
): Promise<T> => {
  if (!redis) return fallback;
  try {
    return await op(redis);
  } catch (err) {
    Logger.warn(
      `Redis 降级 ${context}: ${err instanceof Error ? err.message : String(err)}`,
      'RedisFallback',
    );
    return fallback;
  }
};
