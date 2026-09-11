import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getLoggerConfig } from '../../config/configuration';
import { IsDev } from '../../common/constants/environment';
import { getRequestContext } from '../../common/request-context';
import { sanitizeUrl } from './log-sanitizer';

/**
 * nestjs-pino 只会消费 Params 上的 5 个键（pinoHttp / exclude / forRoutes /
 * useExisting / assignResponse），pino 自身的 level / transport / formatters
 * 必须放进 pinoHttp 内部，放在 Params 根层级会被静默忽略。
 * 下面的类型从 Params['pinoHttp'] 中剔除「输出流 / 二元组」两种形态，只保留 Options。
 */
type PinoHttpOptions = Exclude<
  NonNullable<Params['pinoHttp']>,
  DestinationStream | [unknown, unknown]
>;

/**
 * pino 的 transport.targets 在类型定义中是 readonly 数组，无法直接 push。
 * 这里取出其元素类型后重新声明为可变数组，仅用于本地组装 targets。
 */
type PinoTransportTarget = Extract<
  NonNullable<PinoHttpOptions['transport']>,
  { targets: unknown }
>['targets'][number];

type PinoTransportTargets = PinoTransportTarget[];

/** 健康探针路径：不进访问日志（会被高频调用，日志量没价值） */
const HEALTH_PATHS = new Set([
  '/api/health',
  '/api/health/ready',
  '/health',
  '/health/ready',
]);

function isHealthProbe(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = (url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  return HEALTH_PATHS.has(pathname);
}

/**
 * 企业级 Pino 日志模块
 *
 * 特性：
 * - 结构化 JSON 日志（生产环境 stdout + 文件）
 * - 请求上下文自动关联（requestId）
 * - 文件按大小轮转、错误日志独立落盘（pino-roll）
 * - 敏感字段脱敏（请求头凭证 + URL 查询参数 + 常见业务字段）
 * - 访问日志 / 慢请求 / 客户端中断分级
 * - 与 NestJS Logger 兼容（由 main.ts 通过 app.useLogger 桥接）
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Params => {
        const loggerConfig = getLoggerConfig(configService);

        const wantConsole = loggerConfig.output === 'console';
        const wantFile = loggerConfig.output === 'file';

        const targets: PinoTransportTargets = [];

        if (wantConsole) {
          if (IsDev) {
            targets.push({
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
            });
          } else {
            targets.push({ target: 'pino/file', options: { destination: 1 } });
          }
        }

        if (wantFile) {
          const logDir = loggerConfig.logDir;
          // maxFiles <= 0 表示不限制保留数量：此时不能传 limit.count = 0（那会删空轮转文件）
          const limit =
            loggerConfig.maxFiles > 0
              ? { count: loggerConfig.maxFiles }
              : undefined;

          // 主日志：全级别
          targets.push({
            target: 'pino-roll',
            options: {
              file: `${logDir}/app`,
              size: loggerConfig.maxFileSize,
              extension: '.log',
              mkdir: true,
              limit,
            },
          });

          // 错误日志单独落盘：level 必须写在 target 层，写进 options 会被忽略
          targets.push({
            target: 'pino-roll',
            level: 'error',
            options: {
              file: `${logDir}/error`,
              size: loggerConfig.maxFileSize,
              extension: '.log',
              mkdir: true,
              limit,
            },
          });
        }

        // 兜底：output 配置异常导致没有任何输出目标时，至少写 stdout
        if (targets.length === 0) {
          targets.push({ target: 'pino/file', options: { destination: 1 } });
        }

        const pinoHttp: PinoHttpOptions = {
          level: loggerConfig.level,
          // 不能自定义 level 格式化：pino 的 normalizeArgs 明确禁止
          // 「transport.targets 数组 + formatters.level 函数」的组合，命中即抛
          // "option.transport.targets do not allow custom level formatters" 导致进程启动失败。
          // 本模块为了同时输出 console / 全量文件 / 仅 error 文件，必须使用 targets 多路输出，
          // 因此这里只能用 pino 默认的数字级别（30/40/50…）。
          // 开发控制台由 pino-pretty 渲染成 INFO/ERROR 标签，采集侧按 pino 标准数字级别解析。
          // 兜底脱敏：即使业务代码误把请求/凭证对象交给 logger，也不会明文落盘
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwd',
              '*.secret',
              '*.token',
              '*.accessToken',
              '*.refreshToken',
              '*.apiKey',
            ],
            censor: '[REDACTED]',
          },
          // 复用上游透传的 requestId（网关/调用方），否则生成 UUID
          genReqId: (req: IncomingMessage) => {
            const header = req.headers['x-request-id'];
            if (typeof header === 'string' && header) return header;
            return randomUUID();
          },
          // 健康探针不产生访问日志（只关自动日志，保留应用日志的请求上下文）
          autoLogging: {
            ignore: (req: IncomingMessage): boolean => isHealthProbe(req.url),
          },
          customSuccessMessage: (
            req: IncomingMessage,
            res: ServerResponse,
            responseTime: number,
          ) => {
            const slow = responseTime > loggerConfig.slowRequestThreshold;
            const suffix = slow ? ' [SLOW]' : '';
            return `HTTP ${req.method} ${sanitizeUrl(req.url ?? '')} ${res.statusCode} - ${responseTime}ms${suffix}`;
          },
          customErrorMessage: (
            req: IncomingMessage,
            res: ServerResponse,
            error: Error,
          ) => {
            return `HTTP ${req.method} ${sanitizeUrl(req.url ?? '')} ${res.statusCode} - ERROR: ${error.message}`;
          },
          customReceivedMessage: (req: IncomingMessage) => {
            return `HTTP ${req.method} ${sanitizeUrl(req.url ?? '')} received`;
          },
          // 5xx=error、4xx=warn、其余=info。
          // pino-http 会在「请求到达」和「响应结束」两个时点各调用一次本函数：
          //   - 请求到达时响应尚未写出（headersSent=false、writableEnded=false），应记 info；
          //   - 响应已开始写出却未正常结束（headersSent=true 且 writableEnded=false），
          //     说明连接中途断开（客户端中断 / 超时），升到 warn 便于排查。
          // 不能只判断 !writableEnded，否则「请求到达」也会被判为 warn。
          customLogLevel: (
            _req: IncomingMessage,
            res: ServerResponse,
            error?: Error,
          ) => {
            if (error || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            if (res.headersSent && !res.writableEnded) return 'warn';
            return 'info';
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
              url: sanitizeUrl(req.url ?? ''),
              requestId: req.headers['x-request-id'],
            }),
            res: (res: ServerResponse) => ({
              statusCode: res.statusCode,
            }),
          },
          transport: { targets },
        };

        // 让「拿不到 req 的深层代码」（service / 异步回调）也能凭 CLS 关联 requestId
        if (loggerConfig.includeContext) {
          pinoHttp.mixin = () => {
            const { requestId } = getRequestContext();
            return requestId ? { requestId } : {};
          };
        }

        return { pinoHttp };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
