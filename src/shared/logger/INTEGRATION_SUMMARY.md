# Pino 日志模块集成总结

## 📋 完成的工作

### 1. 依赖安装
- ✅ 安装 `pino` - 高性能结构化日志库
- ✅ 安装 `pino-pretty` - 开发环境人类可读格式输出
- ✅ 安装 `nestjs-pino` - NestJS 与 Pino 的集成适配器

### 2. 核心模块创建

#### 配置接口 (`src/config/configuration.interface.ts`)
新增 `LoggerConfig` 接口,包含以下配置项:
- `level`: 日志级别 (trace/debug/info/warn/error/fatal/silent)
- `jsonFormat`: 是否启用结构化 JSON 日志
- `includeContext`: 是否包含请求上下文
- `slowRequestThreshold`: 慢请求阈值(毫秒)
- `output`: 日志输出目标 (console/file/both)
- `logDir`: 日志文件目录
- `maxFileSize`: 单个日志文件最大大小(MB)
- `maxFiles`: 保留的日志文件数量
- `compressOldFiles`: 是否压缩轮转后的日志文件

#### 配置读取 (`src/config/configuration.ts`)
新增 `getLoggerConfig()` 函数,提供带默认值的配置读取:
```typescript
export const getLoggerConfig = (
  configService: ConfigService,
): Required<LoggerConfig> => { ... }
```

#### 默认配置 (`src/config/config.default.ts`)
添加 logger 配置的默认值,支持环境变量覆盖。

#### Logger 模块 (`src/shared/logger/logger.module.ts`)
企业级 Pino 日志模块,特性包括:
- ✅ Global 模块,全应用可用
- ✅ 异步配置,支持从 ConfigService 读取
- ✅ 生产环境自动使用 JSON 格式
- ✅ 开发环境使用人类可读格式
- ✅ 多输出目标支持(控制台 + 文件)
- ✅ 日志轮转与压缩
- ✅ 错误日志单独文件
- ✅ HTTP 请求日志增强(慢请求检测、自定义消息)
- ✅ 请求序列化(requestId 自动提取)

#### HTTP Logger 中间件 (`src/common/middleware/http-logger.middleware.ts`)
更新为使用 Pino Logger:
- ✅ 注入 PinoLogger 实例
- ✅ 结构化日志输出(包含 requestId、method、url、statusCode、responseTime)
- ✅ 智能分级(5xx=error, 4xx=warn, 其他=info)
- ✅ 完整的日志上下文对象

### 3. 应用集成

#### App Module (`src/app.module.ts`)
- ✅ 导入 LoggerModule
- ✅ 作为全局模块自动生效

#### Main.ts
- ✅ 导入 PinoLogger 类型(可选,用于启动日志)

### 4. 配置示例

#### 环境变量 (`.env`)
添加完整的 Pino 日志配置示例:
```bash
LOG_LEVEL=info
LOG_JSON_FORMAT=true
LOG_SLOW_REQUEST_THRESHOLD=1000
LOG_OUTPUT=both
LOG_DIR=logs
LOG_MAX_FILE_SIZE=10
LOG_MAX_FILES=7
LOG_COMPRESS_OLD_FILES=true
```

### 5. 文档与示例

#### 使用指南 (`src/shared/logger/README.md`)
完整的使用文档,包含:
- 核心特性说明
- 配置详解
- 使用方法(Service/Controller)
- 日志输出示例
- 性能优化建议
- 与日志采集系统集成(ELK/Loki/Datadog)
- 故障排查
- 最佳实践
- 迁移指南

#### 代码示例 (`src/shared/logger/logger-example.service.ts`)
7 个实际使用场景示例:
1. 基础日志记录
2. 带上下文的日志
3. 错误处理与日志
4. 性能监控
5. 批量操作日志
6. 外部 API 调用日志
7. 敏感信息脱敏

## 🎯 企业级特性

### 1. 结构化日志
生产环境输出标准 JSON 格式,便于日志采集系统解析:
```json
{
  "level": "INFO",
  "time": 1726027845123,
  "msg": "HTTP POST /api/users 201 45ms",
  "request": {
    "method": "POST",
    "url": "/api/users",
    "requestId": "req-abc-123"
  },
  "response": {
    "statusCode": 201
  },
  "responseTime": 45
}
```

### 2. 请求上下文关联
自动从 CLS (Continuation Local Storage) 提取:
- `requestId`: 来自 X-Request-ID 请求头
- `userId`: 当前认证用户 ID
- `traceId`: 分布式追踪 ID

### 3. 智能日志分级
根据 HTTP 状态码和响应时间自动选择级别:
- **5xx**: error 级别
- **4xx**: warn 级别
- **慢请求** (>1000ms): 标记 [SLOW],warn 级别
- **其他**: info 级别

### 4. 日志轮转与压缩
- 单文件达到阈值(默认 10MB)自动轮转
- 保留最近 N 个文件(默认 7 个)
- 旧文件自动压缩为 .gz 格式
- 错误日志单独存储(error.log)

### 5. 多输出目标
可同时输出到:
- **控制台**: 开发环境彩色输出,生产环境 JSON
- **文件**: 持久化存储,支持轮转

### 6. 性能优化
- Pino 比 Winston 快 5-10 倍
- 异步日志写入,不阻塞主线程
- 对象序列化优于字符串拼接

## 📊 对比原有方案

| 特性 | 原 NestJS Logger | 新 Pino Logger |
|------|------------------|----------------|
| 性能 | 基准 | **快 5-10 倍** |
| 结构化输出 | ❌ | ✅ JSON |
| 请求上下文 | 手动传递 | **自动关联** |
| 日志轮转 | ❌ | ✅ 内置支持 |
| 多输出目标 | ❌ | ✅ 控制台+文件 |
| 慢请求检测 | ❌ | ✅ 自动标记 |
| 日志采集集成 | 困难 | **原生支持** |
| 开发体验 | 一般 | **彩色输出** |

## 🔧 使用方法

### Service 中使用
```typescript
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class UserService {
  constructor(private readonly logger: PinoLogger) {}

  async createUser(data: CreateUserDto) {
    this.logger.info('Creating user', { username: data.username });
    
    try {
      const user = await this.repository.create(data);
      this.logger.info('User created', { userId: user.id });
      return user;
    } catch (error) {
      this.logger.error('Failed to create user', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
```

### Controller 中使用
```typescript
import { Controller, Get } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Controller('users')
export class UsersController {
  constructor(private readonly logger: PinoLogger) {}

  @Get()
  findAll() {
    this.logger.debug('Fetching all users');
    return this.usersService.findAll();
  }
}
```

## 🚀 下一步建议

### 1. 日志采集系统集成
根据实际需求选择:
- **ELK Stack**: 自建日志平台
- **Grafana Loki**: 轻量级日志聚合
- **Datadog**: 云端监控服务
- **阿里云 SLS**: 国内云服务

### 2. 分布式追踪
集成 OpenTelemetry 或 Jaeger:
```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-trace-node
```

### 3. 告警规则
基于日志设置告警:
- 5xx 错误率 > 1%
- 平均响应时间 > 500ms
- P99 响应时间 > 2000ms

### 4. 日志分析仪表板
创建 Grafana/Kibana 仪表板:
- QPS 趋势图
- 错误率趋势图
- 响应时间百分位(P50/P90/P99)
- Top 慢接口排行

### 5. 日志归档策略
- 热数据: 最近 7 天(快速查询)
- 温数据: 7-30 天(压缩存储)
- 冷数据: 30+ 天(归档到对象存储)

## ⚠️ 注意事项

### 1. 敏感信息脱敏
永远不要在日志中记录:
- ❌ 密码
- ❌ Token/API Key
- ❌ 信用卡号
- ❌ 身份证号
- ✅ 只记录业务必要的标识符(userId、orderId 等)

### 2. 日志级别选择
- **开发环境**: debug
- **测试环境**: info
- **生产环境**: info 或 warn(高流量场景)

### 3. 避免日志爆炸
- ❌ 不在循环中记录详细日志
- ✅ 记录汇总结果而非每条详情
- ✅ 失败时记录详细信息

### 4. 磁盘空间管理
- 定期清理旧日志文件
- 监控日志目录大小
- 设置合理的轮转策略

## 📝 相关文件清单

### 核心文件
- `src/shared/logger/logger.module.ts` - Pino 日志模块
- `src/shared/logger/README.md` - 使用文档
- `src/shared/logger/logger-example.service.ts` - 代码示例

### 配置文件
- `src/config/configuration.interface.ts` - LoggerConfig 接口
- `src/config/configuration.ts` - getLoggerConfig 函数
- `src/config/config.default.ts` - 默认配置
- `.env` - 环境变量示例

### 集成文件
- `src/app.module.ts` - 导入 LoggerModule
- `src/common/middleware/http-logger.middleware.ts` - HTTP 日志中间件

### 依赖包
- `pino@10.3.1`
- `pino-pretty@13.1.3`
- `nestjs-pino@5.1.0`

## ✅ 验证清单

- [x] 依赖安装成功
- [x] TypeScript 编译通过
- [x] 配置接口定义完整
- [x] Logger 模块正确注册
- [x] HTTP 中间件更新完成
- [x] 环境变量配置齐全
- [x] 使用文档编写完整
- [x] 代码示例清晰易懂
- [x] 构建无错误

## 🎉 总结

已成功为企业级 NestJS 项目集成 Pino 日志系统,具备:
- ✅ 高性能结构化日志输出
- ✅ 自动请求上下文关联
- ✅ 智能日志分级与慢请求检测
- ✅ 日志轮转、压缩与多输出
- ✅ 完整的配置体系与文档
- ✅ 丰富的使用示例与最佳实践

该系统可直接用于生产环境,支持大规模高并发场景下的日志记录与分析需求。
