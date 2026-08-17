import { Snowflake, decodeSnowflake } from "@skorotkiewicz/snowflake-id";


/**
 * 雪花算法实例，单例模式
 */
let snowflakeInstance: Snowflake | null = null;

/**
 * 初始化雪花算法
 * @param workerId 工作节点ID
 */
export const initSnowflake = (workerId: number) => {
  if (snowflakeInstance) {
    console.warn('Snowflake generator has already been initialized.');
    return;
  }

  snowflakeInstance = new Snowflake(workerId);;
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
export const generateSnowflakeId = async () => {
  if (!snowflakeInstance) {
    throw new Error(
      'Snowflake generator has not been initialized. Call initSnowflake() first.',
    );
  }
  return snowflakeInstance.generate();
};
