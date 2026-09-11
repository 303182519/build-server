import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';
import { stdSerializers, type DestinationStream } from 'pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLoggerConfig } from '../../config/configuration';
import { IsDev } from '../../common/constants/environment';
import { getRequestContext } from '../../common/request-context';
import { resolveRequestId } from '../../common/request-id';
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

/**
 * pino-http 的 `wrapRequestSerializer` 会先跑 pino-std-serializers 的 `reqSerializer`，
 * 再把「规范化后的对象」交给自定义序列化器，因此这里拿到的并不是原始 `IncomingMessage`
 * （实际含 id / method / url / query / params / headers / remoteAddress / remotePort，
 * 其中 `headers` 即原始请求头）。这里只声明真正读取的字段，避免对类型撒谎。
 */
interface NormalizedRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

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
          // if (IsDev) {
          //   targets.push({
          //     target: 'pino-pretty',
          //     options: {
          //       colorize: true,
          //       translateTime: 'SYS:standard',
          //       ignore: 'pid,hostname',
          //     },
          //   });
          // } else {
          targets.push({ target: 'pino/file', options: { destination: 1 } });
          //}
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
          // 兜底脱敏：即使业务代码误把请求/凭证对象交给 logger，也不会明文落盘。
          //
          // 路径必须按 access log 的「顶层键名」书写：customAttributeKeys 已把请求/响应对象
          // 重命名为 request / response，所以 `req.headers.*` / `res.headers.*` 这类路径
          // **永远不会命中**（踩坑点）。这里统一用 `*.` 通配前缀，而不是 `request.` / `response.`：
          // 1）pino 按顶层键选取脱敏 stringifier，`request.` 这类具体前缀会为 `request` 键单独
          //    生成一个 stringifier，它与已有的 `*.xxx` 通配路径之间的优先关系属于实现细节；
          //    而 `*.` 前缀统一由 pino 的 wildcardFirst stringifier 处理，语义稳定；
          // 2）`*.headers.*` 能覆盖任何「误把 headers 放进日志对象」的场景，而不只是 pino-http 的绑定。
          redact: {
            paths: [
              '*.headers.authorization',
              '*.headers.cookie',
              '*.headers["set-cookie"]',
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
          // 复用上游透传的 requestId（网关/调用方），否则生成 UUID。
          // 与 RequestIdMiddleware 共用同一解析函数：两侧必须落在同一个值上，
          // 否则「访问日志里的 requestId」与「响应头 / 响应体里的 requestId」会不一致。
          genReqId: (req: IncomingMessage) => resolveRequestId(req),
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
          // 5xx=error、4xx=warn、其余=info。
          // 注意：customLogLevel 会同时被「请求到达」和「响应结束」两个时点调用，
          // 这里之所以能只按响应结束时序判断，正是因为上面没有开启「请求到达」日志。
          // 若将来要重新引入到达日志，必须重新区分两个时点，否则到达日志会被判成 warn。
          customLogLevel: (
            _req: IncomingMessage,
            res: ServerResponse,
            error?: Error,
          ) => {
            if (error || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            // 响应未正常结束 = 连接被客户端中断 / 超时，升到 warn 便于排查
            if (!res.writableEnded) return 'warn';
            return 'info';
          },
          customAttributeKeys: {
            req: 'request',
            res: 'response',
            err: 'error',
            responseTime: 'responseTime',
            // 决定 quietReqLogger 创建的 child 用哪个键名绑定 requestId
            // （pino-http 默认是 'reqId'）。字段契约要求顶层只出现 `requestId`，故对齐为同名。
            reqId: 'requestId',
          },
          // 【为什么必须开】顶层 requestId 不能只靠下方 mixin 读 CLS：
          // mixin 依赖 AsyncLocalStorage，而 store 只存在于 RequestContextMiddleware 的
          // run() 派生链里。长连接 / 手动 @Res() 的响应（SSE 事件流、文件下载）往往是在
          // socket close 回调或 Redis Pub/Sub 回调里执行 res.end()，此时已脱离请求链，
          // mixin 读不到 store → 访问日志丢失顶层 requestId（踩坑案例：GET /api/jobs/:id/events）。
          // pino-http 则在请求进入时就把 requestId 作为 child binding 绑在请求级 logger 上
          // （`req.id = req.id || genReqId(...)` 之后 `logger.child({ [reqIdKey]: req.id })`），
          // 该绑定与「谁触发 res.end()」无关，因此长连接也必然带上。
          // 注意：只有 quietReqLogger=true 时 pino-http 才会创建这个 child——默认 false 时
          // reqId 只以 `req.id` 形式藏在 request 序列化对象里，访问日志根本看不到。
          // 副作用（预期内）：应用日志（req.log / nestjs-pino 的 PinoLogger）不再携带 request
          // 序列化对象，与「HTTP 维度只由访问日志承载」的字段契约一致。
          // quietResLogger 保持默认 false：访问日志仍需要 request / response / responseTime。
          quietReqLogger: true,
          serializers: {
            // 只输出白名单字段（见 ADR-002 决策第 10 条）。规范化对象虽然含 headers，但请求头里
            // 绝大多数内容是凭证 / PII，且 Cookie 常有 KB 级体积，整包落盘会同时带来泄露风险与
            // 存储成本。这里只取「排障价值高、基数可控、不含凭据」的两项：
            // - user-agent：客户端 / 版本 / 爬虫识别；
            // - content-type：400 / 415 之类报文异常的排查依据。
            // referer 故意不记：它可能携带一次性凭据，而 sanitizeUrl() 只覆盖 query，path 段
            // 无法脱敏，收益低于风险。
            //
            // requestId 不在这里输出：全链路只保留顶层 `requestId`（由 pino-http 的
            // quietReqLogger 请求级绑定注入，mixin 在 CLS 可用时给出同值兜底，见下方），
            // 避免同一维度出现「request.requestId」与顶层「requestId」两条字段路径。
            // x-request-id 同理，已由 genReqId + 请求级绑定落在顶层 requestId 上。
            req: (req: NormalizedRequest) => {
              const headers = req.headers ?? {};
              return {
                method: req.method,
                url: sanitizeUrl(req.url ?? ''),
                userAgent: headers['user-agent'],
                contentType: headers['content-type'],
              };
            },
            res: (res: ServerResponse) => ({
              statusCode: res.statusCode,
            }),
            // pino 默认不序列化 Error 实例：不注册时 `{ err: exception }` 会落成 `{}`，
            // message / stack 全部丢失（全局异常过滤器正是靠它记录 5xx 堆栈）。
            // pino-http 只会把 errKey（按 customAttributeKeys 为 'error'）写进 serializers，
            // 不会占用 'err' 键，因此这里注册 'err' 与访问日志的 'error' 互不干扰。
            err: stdSerializers.err,
          },
          transport: { targets },
        };

        // 让「拿不到 req 的深层代码」（service / 异步回调）也能凭 CLS 关联 requestId
        // ——requestId 的**权威来源**已是 pino-http 的请求级绑定（见上方 quietReqLogger），
        // 这里注入的是同值兜底（两侧共用 resolveRequestId，必然一致），保留是为了兼容
        // 「手动开 CLS 写 requestId」的非 HTTP 场景；
        // 更关键的作用是把异常过滤器写入的业务码注入日志：bizCode 只能在响应结束前写进
        // CLS，因此「响应结束的那条访问日志」自带 bizCode，4xx 不必再由异常过滤器单独
        // 产出一条重复日志（见 ADR-002）。
        if (loggerConfig.includeContext) {
          pinoHttp.mixin = () => {
            const { requestId, bizCode } = getRequestContext();
            const props: Record<string, string> = {};
            if (requestId) props.requestId = requestId;
            if (bizCode) props.bizCode = bizCode;
            return props;
          };
        }

        return { pinoHttp };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
