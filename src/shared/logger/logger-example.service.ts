import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/**
 * Pino 日志使用示例 Service
 *
 * 展示如何在业务代码中正确使用 Pino 日志系统
 */
@Injectable()
export class LoggerExampleService {
  constructor(private readonly logger: PinoLogger) {}

  /**
   * 示例 1: 基础日志记录
   */
  async basicLogging(): Promise<void> {
    // Info 级别 - 常规业务操作
    this.logger.info('Processing user request');

    // Debug 级别 - 开发调试信息
    this.logger.debug('Cache lookup', { cacheKey: 'user:123' });

    // Warn 级别 - 需要关注但不影响运行
    this.logger.warn('Deprecated API endpoint accessed', {
      endpoint: '/api/v1/users',
    });

    // Error 级别 - 错误但程序仍可运行
    this.logger.error('Failed to send email', {
      recipient: 'user@example.com',
      error: 'SMTP connection timeout',
    });
  }

  /**
   * 示例 2: 带上下文的日志(推荐)
   *
   * Pino 会自动从请求上下文中提取 requestId、userId 等信息
   * 无需手动传递,只需在第二个参数传入业务相关的上下文
   */
  async contextualLogging(userId: string, action: string): Promise<void> {
    this.logger.info('User action performed', {
      userId,
      action,
      timestamp: new Date().toISOString(),
    });

    // 输出示例:
    // {"level":"INFO","msg":"User action performed","userId":"user-123","action":"login","requestId":"req-abc","timestamp":"2026-09-11T10:30:45.123Z"}
  }

  /**
   * 示例 3: 错误处理与日志
   */
  async errorHandlingExample(dataId: string): Promise<void> {
    try {
      this.logger.debug('Fetching data', { dataId });

      // 模拟可能失败的操作
      const result = await this.fetchData(dataId);

      this.logger.info('Data fetched successfully', {
        dataId,
        dataSize: result.length,
      });
    } catch (error) {
      // 错误日志应包含完整的错误信息和堆栈
      this.logger.error('Failed to fetch data', {
        dataId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorCode: error instanceof Error ? error.name : 'UnknownError',
      });

      // 重新抛出或处理错误
      throw error;
    }
  }

  /**
   * 示例 4: 性能监控
   */
  async performanceMonitoring(): Promise<void> {
    const startTime = Date.now();

    try {
      // 模拟耗时操作
      await this.expensiveOperation();

      const duration = Date.now() - startTime;
      this.logger.info('Operation completed', { duration });

      // 如果超过阈值,记录为警告
      if (duration > 1000) {
        this.logger.warn('Slow operation detected', {
          duration,
          threshold: 1000,
        });
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('Operation failed', { duration, error: error.message });
    }
  }

  /**
   * 示例 5: 批量操作日志
   *
   * 避免在循环中记录过多日志
   */
  async batchProcessing(items: any[]): Promise<void> {
    const totalCount = items.length;
    this.logger.info('Starting batch processing', { totalCount });

    let successCount = 0;
    let failureCount = 0;

    for (const item of items) {
      try {
        await this.processItem(item);
        successCount++;
      } catch (error) {
        failureCount++;
        // 只记录失败的详细信息,避免日志爆炸
        this.logger.error('Failed to process item', {
          itemId: item.id,
          error: error.message,
        });
      }
    }

    // 记录汇总结果
    this.logger.info('Batch processing completed', {
      totalCount,
      successCount,
      failureCount,
      successRate: `${((successCount / totalCount) * 100).toFixed(2)}%`,
    });
  }

  /**
   * 示例 6: 外部 API 调用日志
   */
  async externalApiCall(apiName: string, payload: any): Promise<any> {
    this.logger.info('Calling external API', {
      apiName,
      payloadSize: JSON.stringify(payload).length,
    });

    const startTime = Date.now();

    try {
      const response = await this.callExternalAPI(apiName, payload);
      const duration = Date.now() - startTime;

      this.logger.info('External API call succeeded', {
        apiName,
        duration,
        statusCode: response.status,
      });

      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger.error('External API call failed', {
        apiName,
        duration,
        errorMessage: error.message,
        errorCode: error.response?.status,
      });

      throw error;
    }
  }

  /**
   * 示例 7: 敏感信息脱敏
   *
   * 永远不要在日志中记录密码、令牌等敏感信息
   */
  async secureLogging(user: any): Promise<void> {
    // ❌ 错误做法 - 泄露敏感信息
    // this.logger.info('User login', { password: user.password });

    // ✅ 正确做法 - 只记录必要信息
    this.logger.info('User login attempt', {
      userId: user.id,
      username: user.username,
      ip: user.lastLoginIp,
      // 不要记录: password, token, creditCard, etc.
    });
  }

  // ==================== 辅助方法 ====================

  private async fetchData(dataId: string): Promise<any[]> {
    // 模拟数据获取
    return [{ id: dataId, name: 'Test Data' }];
  }

  private async expensiveOperation(): Promise<void> {
    // 模拟耗时操作
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  private async processItem(item: any): Promise<void> {
    // 模拟项目处理
    if (Math.random() > 0.9) {
      throw new Error('Random processing failure');
    }
  }

  private async callExternalAPI(apiName: string, payload: any): Promise<any> {
    // 模拟外部 API 调用
    return {
      status: 200,
      data: { success: true },
    };
  }
}
