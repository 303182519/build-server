/**
 * Pino 日志快速测试脚本
 *
 * 使用方法:
 * 1. 启动应用: pnpm run start:dev
 * 2. 访问以下端点测试日志输出:
 *    - GET /api/health (健康检查,应记录 info 级别日志)
 *    - 触发任意 API 查看 HTTP 访问日志
 * 3. 查看 logs/ 目录下的日志文件
 */

import { Controller, Get } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Controller('test-logger')
export class TestLoggerController {
  constructor(private readonly logger: PinoLogger) {}

  /**
   * 测试基础日志
   * GET /api/test-logger/basic
   */
  @Get('basic')
  testBasic() {
    this.logger.trace('Trace level log');
    this.logger.debug('Debug level log');
    this.logger.info('Info level log');
    this.logger.warn('Warn level log');
    this.logger.error('Error level log');

    return { message: 'Check console for logs' };
  }

  /**
   * 测试带上下文的日志
   * GET /api/test-logger/context
   */
  @Get('context')
  testContext() {
    this.logger.info('User action', {
      userId: 'user-123',
      action: 'login',
      ip: '192.168.1.100',
    });

    return { message: 'Contextual log recorded' };
  }

  /**
   * 测试错误日志
   * GET /api/test-logger/error
   */
  @Get('error')
  testError() {
    try {
      throw new Error('Test error for logging');
    } catch (error) {
      this.logger.error('Caught an error', {
        errorMessage: error.message,
        errorStack: error.stack,
        errorCode: error.name,
      });
    }

    return { message: 'Error logged' };
  }

  /**
   * 测试性能监控
   * GET /api/test-logger/performance
   */
  @Get('performance')
  async testPerformance() {
    const startTime = Date.now();

    // 模拟耗时操作
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const duration = Date.now() - startTime;

    this.logger.info('Operation completed', { duration });

    if (duration > 1000) {
      this.logger.warn('Slow operation detected', {
        duration,
        threshold: 1000,
      });
    }

    return { message: `Completed in ${duration}ms`, duration };
  }

  /**
   * 测试批量操作日志
   * GET /api/test-logger/batch
   */
  @Get('batch')
  async testBatch() {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));

    this.logger.info('Starting batch processing', { totalCount: items.length });

    let successCount = 0;
    let failureCount = 0;

    for (const item of items) {
      try {
        // 模拟随机失败
        if (Math.random() > 0.8) {
          throw new Error(`Random failure for item ${item.id}`);
        }

        successCount++;
      } catch (error) {
        failureCount++;
        this.logger.error('Failed to process item', {
          itemId: item.id,
          error: error.message,
        });
      }
    }

    this.logger.info('Batch processing completed', {
      totalCount: items.length,
      successCount,
      failureCount,
      successRate: `${((successCount / items.length) * 100).toFixed(2)}%`,
    });

    return { successCount, failureCount };
  }

  /**
   * 测试敏感信息脱敏
   * GET /api/test-logger/secure
   */
  @Get('secure')
  testSecure() {
    // ✅ 正确做法
    this.logger.info('Login attempt', {
      userId: 'user-456',
      username: 'john.doe',
      ip: '10.0.0.1',
      // ❌ 永远不要记录这些
      // password: 'secret123',
      // token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    });

    return { message: 'Secure log recorded (no sensitive data)' };
  }
}
