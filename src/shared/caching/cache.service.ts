import KeyvRedis from '@keyv/redis';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';

/** SCAN + DELETE 操作所需的最小节点接口 */
interface ScanNode {
  scanIterator: (opts: {
    MATCH: string;
    COUNT: number;
  }) => AsyncIterable<string | string[]>;
  unlink: (keys: string[]) => Promise<number>;
  del: (keys: string[]) => Promise<number>;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  /**
   * 当前缓存底层是否为 Redis。
   * 业务模块可据此切换"Redis 模式"与"无 Redis 时的回退实现"。
   */
  isRedisEnabled(): boolean {
    return this.getRedisStore() !== null;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  /**
   * @param ttlSeconds 秒；不传则使用模块默认 TTL
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<T> {
    const ttl = typeof ttlSeconds === 'number' ? ttlSeconds * 1000 : undefined;
    return this.cache.set<T>(key, value, ttl);
  }

  async del(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) return this.cache.mdel(key);
    return this.cache.del(key);
  }

  async rotateRefreshToken(
    oldKey: string,
    newKey: string,
    expectedValue: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const redisStore = this.getRedisStore();
    if (!redisStore) return false;

    const client = redisStore.client;
    const namespace = redisStore.namespace;
    const separator = redisStore.keyPrefixSeparator;
    const formatKey = (key: string) =>
      namespace ? `${namespace}${separator}${key}` : key;

    const result = await client.eval(
      `
        if redis.call("GET", KEYS[1]) ~= ARGV[1] then
          return 0
        end

        redis.call("DEL", KEYS[1])
        if tonumber(ARGV[2]) > 0 then
          redis.call("SET", KEYS[2], ARGV[1], "PX", ARGV[2])
        else
          redis.call("SET", KEYS[2], ARGV[1])
        end
        return 1
      `,
      {
        keys: [formatKey(oldKey), formatKey(newKey)],
        arguments: [expectedValue, String(ttlSeconds * 1000)],
      },
    );

    return result === 1;
  }

  /**
   * 命中直接返回；未命中执行 loader 后写入。
   * 注意：本期不引入分布式锁，存在惊群可能。
   */
  async wrap<T>(
    key: string,
    loader: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    const ttl = typeof ttlSeconds === 'number' ? ttlSeconds * 1000 : undefined;
    return this.cache.wrap<T>(key, loader, ttl);
  }

  /**
   * 按 pattern 失效缓存（仅 Redis store 支持）。
   * 自动检测单机 / 集群模式：
   * - 单机：对唯一节点执行 SCAN + DELETE
   * - 集群：并行对所有 master 节点分别执行 SCAN + DELETE，单节点失败不阻塞其余
   * pattern 是 Redis SCAN 的 MATCH 模式，会自动叠加 keyPrefix 命名空间。
   * 例：传入 "user:*" 删除所有以 "user:" 开头的缓存
   */
  async invalidatePattern(pattern: string): Promise<number> {
    const redisStore = this.getRedisStore();
    if (!redisStore) {
      this.logger.warn(
        `invalidatePattern 在内存 store 下不支持，已忽略 pattern=${pattern}`,
      );
      return 0;
    }

    const namespace = redisStore.namespace;
    const separator = redisStore.keyPrefixSeparator;
    const fullPattern = namespace
      ? `${namespace}${separator}${pattern}`
      : pattern;

    const client = redisStore.client;
    const useUnlink = redisStore.useUnlink;

    // 集群模式：key 按 hash slot 分布在多个 master 上，必须逐节点 SCAN
    if (this.isClusterClient(client)) {
      const cluster = client as unknown as {
        masters: Map<string, ScanNode>;
      };
      const nodes = [...cluster.masters.values()];

      const settled = await Promise.allSettled(
        nodes.map((node) =>
          this.scanAndDeleteNode(node, fullPattern, useUnlink),
        ),
      );

      let deleted = 0;
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          deleted += result.value;
        } else {
          this.logger.warn(
            `invalidatePattern 集群节点 SCAN 失败，已跳过: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
      return deleted;
    }

    // 单机模式
    return this.scanAndDeleteNode(
      client as unknown as ScanNode,
      fullPattern,
      useUnlink,
    );
  }

  /**
   * 对单个 Redis 节点执行 SCAN 匹配 + 批量删除，返回删除数量。
   * 供单机与集群模式共用：单机调用一次，集群对每个 master 各调用一次。
   */
  private async scanAndDeleteNode(
    node: ScanNode,
    pattern: string,
    useUnlink: boolean,
  ): Promise<number> {
    let deleted = 0;
    const batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const fn = useUnlink ? node.unlink : node.del;
      deleted += await fn.call(node, batch.splice(0));
    };

    for await (const chunk of node.scanIterator({
      MATCH: pattern,
      COUNT: 200,
    })) {
      if (Array.isArray(chunk)) batch.push(...chunk);
      else batch.push(chunk);
      if (batch.length >= 500) await flush();
    }
    await flush();
    return deleted;
  }

  /**
   * 检测底层 Redis client 是否为 Cluster 实例。
   * @redis/client v5 的 Cluster 对象持有 masters 属性（Map<address, node>）。
   */
  private isClusterClient(client: unknown): boolean {
    return (
      client != null &&
      typeof client === 'object' &&
      'masters' in client &&
      client.masters instanceof Map
    );
  }

  private getRedisStore(): KeyvRedis<unknown> | null {
    for (const keyv of this.cache.stores) {
      const store = (keyv as unknown as { store?: unknown }).store;
      if (store instanceof KeyvRedis) return store as KeyvRedis<unknown>;
    }
    return null;
  }
}
