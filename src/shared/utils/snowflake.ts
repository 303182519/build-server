/**
 * 雪花算法（Snowflake）
 *
 * Twitter的雪花算法解决了在分布式系统中生成唯一ID的需求。
 * bit（比特）：计算机最小的单位，1 bit 就代表 1 个二进制位，只能存 0 或者 1。
 * N 个 bit，能表示数字的总个数 = 2 的 N 次方
 *
 * 64位ID构成:
 * 1 bit   - `符号位`，始终为0，保证ID为正数。
 * 41 bits - `时间戳`，表示从一个自定义纪元（epoch）以来的毫秒数。可以使用约69年。
 * 10 bits - `数据中心ID` (5 bits) 和 `工作节点ID` (5 bits)，允许最多32个数据中心和32个节点。
 * 12 bits - `序列号`，表示在同一毫秒内生成的序列号，支持每毫秒生成4096个ID。
 *
 * 注意: JavaScript 的 `number` 类型无法精确表示64位整数，因此我们使用 `BigInt`。
 */
export class Snowflake {
  // 自定义纪元（2025-01-20T00:00:00.000Z）
  private static readonly EPOCH = 1737302400000n;

  // 工作节点ID位数-2⁵ = 32，可以存数字：0 ~ 31，正好 32 个数字。
  private static readonly WORKER_ID_BITS = 5n;
  // 数据中心ID位数-2⁵ = 32，可以存数字：0 ~ 31，正好 32 个数字。
  private static readonly DATACENTER_ID_BITS = 5n;
  // 序列号位数-2¹² = 4096，可以存数字：0 ~ 4095，正好 4096 个数字。
  private static readonly SEQUENCE_BITS = 12n;

  // 最大工作节点ID
  private static readonly MAX_WORKER_ID = -1n ^ (-1n << this.WORKER_ID_BITS);
  // 最大数据中心ID
  private static readonly MAX_DATACENTER_ID =
    -1n ^ (-1n << this.DATACENTER_ID_BITS);
  // 序列号掩码
  private static readonly SEQUENCE_MASK = -1n ^ (-1n << this.SEQUENCE_BITS);

  // 工作节点ID左移位数
  private static readonly WORKER_ID_SHIFT = this.SEQUENCE_BITS;
  // 数据中心ID左移位数
  private static readonly DATACENTER_ID_SHIFT =
    this.SEQUENCE_BITS + this.WORKER_ID_BITS;
  // 时间戳左移位数
  private static readonly TIMESTAMP_LEFT_SHIFT =
    this.SEQUENCE_BITS + this.WORKER_ID_BITS + this.DATACENTER_ID_BITS;

  // 序列号
  private sequence = 0n;
  // 上次生成ID的时间戳
  private lastTimestamp = -1n;

  /**
   * datacenterId 数据中心 ID 0‑31；workerId工作节点 ID 0‑31
   *  雪花 10 位分给两部分：
   *  5 bit → datacenterId：数据中心 ID，范围 0 ~ 31，最多 31 个机房
   *  5 bit → workerId：机器 / 实例节点 ID，范围 0 ~31，每个机房最多 31 台机器
   *  组合：datacenterId(5bit) + workerId(5bit) 一共 10bit
   *  总共支持：32 × 32 = 1024 台机器同时生成 ID。
   * @param workerId 工作节点ID (0-31)
   * @param datacenterId 数据中心ID (0-31)
   */
  constructor(
    private readonly workerId: bigint = 0n,
    private readonly datacenterId: bigint = 0n,
  ) {
    if (this.workerId > Snowflake.MAX_WORKER_ID || this.workerId < 0) {
      throw new Error(
        `Worker ID can't be greater than ${Snowflake.MAX_WORKER_ID} or less than 0`,
      );
    }
    if (
      this.datacenterId > Snowflake.MAX_DATACENTER_ID ||
      this.datacenterId < 0
    ) {
      throw new Error(
        `Datacenter ID can't be greater than ${Snowflake.MAX_DATACENTER_ID} or less than 0`,
      );
    }
  }

  /**
   * 生成下一个唯一ID
   * @returns {bigint} 64位唯一ID
   */
  public nextId(): bigint {
    let timestamp = this.timeGen();

    if (timestamp < this.lastTimestamp) {
      // 如果当前时间小于上一次ID生成的时间戳，说明系统时钟回退过，抛出异常
      throw new Error(
        `Clock moved backwards. Refusing to generate id for ${
          this.lastTimestamp - timestamp
        } milliseconds`,
      );
    }

    if (this.lastTimestamp === timestamp) {
      // 如果是同一时间生成的，则进行毫秒内序列
      this.sequence = (this.sequence + 1n) & Snowflake.SEQUENCE_MASK;
      if (this.sequence === 0n) {
        // 毫秒内序列溢出
        timestamp = this.tilNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    return (
      ((timestamp - Snowflake.EPOCH) << Snowflake.TIMESTAMP_LEFT_SHIFT) |
      (this.datacenterId << Snowflake.DATACENTER_ID_SHIFT) |
      (this.workerId << Snowflake.WORKER_ID_SHIFT) |
      this.sequence
    );
  }

  /**
   * 阻塞到下一个毫秒，直到获得新的时间戳
   * @param lastTimestamp 上次生成ID的时间截
   * @returns {bigint} 当前时间戳
   */
  private tilNextMillis(lastTimestamp: bigint): bigint {
    let timestamp = this.timeGen();

    while (timestamp <= lastTimestamp) {
      timestamp = this.timeGen();
    }

    return timestamp;
  }

  /**
   * 返回以毫秒为单位的当前时间
   * @returns {bigint} 当前时间(毫秒)
   */
  private timeGen(): bigint {
    return BigInt(Date.now());
  }
}

/**
 * 雪花算法实例，单例模式
 */
let snowflakeInstance: Snowflake | null = null;

/**
 * 初始化雪花算法
 * @param workerId 工作节点ID
 * @param datacenterId 数据中心ID
 */
export const initSnowflake = (workerId: bigint, datacenterId: bigint) => {
  if (snowflakeInstance) {
    console.warn('Snowflake generator has already been initialized.');
    return;
  }

  // 机房	datacenterId	实例	workerId	完整组合 (datacenterId,workerId)
  // 广州机房	0	实例 A	0	(0, 0)
  // 广州机房	0	实例 B	1	(0, 1)
  // 广州机房	0	实例 C	2	(0, 2)
  // 上海机房	1	实例 A	0	(1, 0)
  // 上海机房	1	实例 B	1	(1, 1)
  // 上海机房	1	实例 C	2	(1, 2)
  snowflakeInstance = new Snowflake(workerId, datacenterId);
};

/**
 * 重置雪花算法
 */
export const resetSnowflake = () => {
  snowflakeInstance = null;
};

/**
 * 生成一个雪花ID (字符串形式)
 */
export const generateSnowflakeId = (): string => {
  if (!snowflakeInstance) {
    throw new Error(
      'Snowflake generator has not been initialized. Call initSnowflake() first.',
    );
  }
  return snowflakeInstance.nextId().toString();
};
