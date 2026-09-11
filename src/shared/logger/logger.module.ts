import { Module, Global } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { getLoggerConfig } from '../../config/configuration';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * 企业级 Pino 日志模块
 *
 * 特性：
 * - 结构化 JSON 日志（生产环境）
 * - 请求上下文自动注入（requestId, userId, traceId）
 * - 日志轮转和压缩
 * - 多输出目标（控制台 + 文件）
 * - 慢请求检测
 * - 与 NestJS Logger 兼容
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const loggerConfig = getLoggerConfig(configService);
        const isProduction = process.env.NODE_ENV === 'production';

        // 基础配置
        const baseConfig: any = {
          level: loggerConfig.level,
          timestamp: true,
          formatters: {
            level: (label: string) => ({ level: label.toUpperCase() }),
          },
        };

        // 生产环境使用 JSON 格式，开发环境使用人类可读格式
        if (loggerConfig.jsonFormat || isProduction) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          baseConfig.transport = {
            targets: [],
          };

          // 控制台输出（JSON 格式）
          if (
            loggerConfig.output === 'console' ||
            loggerConfig.output === 'both'
          ) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            baseConfig.transport.targets.push({
              target: 'pino-pretty',
              options: {
                colorize: !isProduction,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
            });
          }

          // 文件输出（带轮转）
          if (
            loggerConfig.output === 'file' ||
            loggerConfig.output === 'both'
          ) {
            const logDir = loggerConfig.logDir;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            baseConfig.transport.targets.push({
              target: 'pino/file',
              options: {
                destination: `${logDir}/app.log`,
                mkdir: true,
                rotate: true,
                size: `${loggerConfig.maxFileSize || 10}M`,
                count: loggerConfig.maxFiles || 7,
                compress: loggerConfig.compressOldFiles ?? true,
              },
            });

            // 错误日志单独文件
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            baseConfig.transport.targets.push({
              target: 'pino/file',
              options: {
                destination: `${logDir}/error.log`,
                mkdir: true,
                level: 'error',
                rotate: true,
                size: `${loggerConfig.maxFileSize || 10}M`,
                count: loggerConfig.maxFiles || 7,
                compress: loggerConfig.compressOldFiles ?? true,
              },
            });
          }
        } else {
          // 开发环境：简单的人类可读格式
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          baseConfig.transport = {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return {
          pinoHttp: {
            customSuccessMessage: (
              req: IncomingMessage,
              res: ServerResponse,
              payload: { responseTime: number },
            ) => {
              const responseTime = payload.responseTime;
              const slowThreshold = loggerConfig.slowRequestThreshold || 1000;
              if (responseTime > slowThreshold) {
                return `HTTP ${req.method} ${req.url} ${res.statusCode} - ${responseTime}ms [SLOW]`;
              }
              return `HTTP ${req.method} ${req.url} ${res.statusCode} - ${responseTime}ms`;
            },
            customErrorMessage: (
              req: IncomingMessage,
              res: ServerResponse,
              error: Error,
            ) => {
              return `HTTP ${req.method} ${req.url} ${res.statusCode} - ERROR: ${error.message}`;
            },
            // 请求刚抵达服务端时触发（收到请求，还没处理），打印一条「请求已接收」日志。
            // 只有你开启 `quietReqLogger: false` 才会输出收到请求的日志
            customReceivedMessage: (req: IncomingMessage) => {
              return `HTTP ${req.method} ${req.url} received`;
            },
            customAttributeKeys: {
              req: 'request',
              res: 'response',
              err: 'error',
              responseTime: 'responseTime',
            },
            serializers: {
              req: (req: IncomingMessage) => ({
                method: req.method,
                url: req.url,
                requestId: req.headers['x-request-id'],
              }),
              res: (res: ServerResponse) => ({
                statusCode: res.statusCode,
              }),
            },
          },
          ...baseConfig,
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
