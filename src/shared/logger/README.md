# Pino 日志模块使用指南

## 概述

本项目已集成企业级 Pino 日志系统,提供结构化、高性能的日志记录能力。

## 核心特性

- ✅ **结构化 JSON 日志**:生产环境自动输出机器可读的 JSON 格式
- ✅ **请求上下文关联**:自动注入 requestId、userId、traceId 等上下文
- ✅ **智能日志分级**:根据 HTTP 状态码和响应时间自动选择日志级别
- ✅ **日志轮转与压缩**:自动管理日志文件大小,支持压缩旧文件
- ✅ **多输出目标**:可同时输出到控制台和文件
- ✅ **慢请求检测**:超过阈值的请求自动标记为 [SLOW]
- ✅ **NestJS Logger 兼容**:无缝替换原有 NestJS Logger

## 配置说明

### 环境变量

在 `.env` 文件中配置以下参数:

```bash
# 日志级别:trace < debug < info < warn < error < fatal < silent
LOG_LEVEL=info

# 是否启用结构化 JSON 日志(生产环境推荐 true)
LOG_JSON_FORMAT=true

# 慢请求阈值(毫秒)
LOG_SLOW_REQUEST_THRESHOLD=1000

# 日志输出目标:console | file | both
LOG_OUTPUT=both

# 日志文件目录
LOG_DIR=logs

# 单个日志文件最大大小(MB)
LOG_MAX_FILE_SIZE=10

# 保留的日志文件数量(0 = 不限制)
LOG_MAX_FILES=7

# 是否压缩轮转后的旧日志文件
LOG_COMPRESS_OLD_FILES=true
```

### 开发/生产环境差异

| 配置项       | 开发环境默认值     | 生产环境默认值 |
| ------------ | ------------------ | -------------- |
| LOG_LEVEL    | debug              | info           |
| LOG_JSON_FORMAT | false           | true           |
| LOG_OUTPUT   | both               | both           |

## 使用方法

### 1. 在 Service 中使用

```typescript
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Injectable()
export class UserService {
  constructor(private readonly logger: PinoLogger) {}

  async createUser(data: CreateUserDto) {
    // 基础日志
    this.logger.info('Creating new user', { username: data.username });

    try {
      const user = await this.userRepository.create(data);
      this.logger.info('User created successfully', { userId: user.id });
      return user;
    } catch (error) {
      // 错误日志(自动包含堆栈信息)
      this.logger.error('Failed to create user', {
        error: error.message,
        stack: error.stack,
        username: data.username,
      });
      throw error;
    }
  }
}
```

### 2. 在 Controller 中使用

```typescript
import { Controller, Get, Param } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

@Controller('users')
export class UsersController {
  constructor(private readonly logger: PinoLogger) {}

  @Get(':id')
  async findOne(@Param('id') id: string) {
    this.logger.debug('Fetching user by ID', { userId: id });
    
    const user = await this.usersService.findOne(id);
    
    if (!user) {
      this.logger.warn('User not found', { userId: id });
      throw new NotFoundException();
    }
    
    return user;
  }
}
```

### 3. 带上下文的日志

Pino 会自动从请求上下文中提取以下信息并附加到日志中:

- `requestId`: 来自 `X-Request-ID` 请求头
- `userId`: 当前认证用户的 ID(如果已登录)
- `traceId`: 分布式追踪 ID(如果存在)

```typescript
// 无需手动传递,自动关联
this.logger.info('Processing payment', { amount: 100 });
// 输出: {"level":"INFO","msg":"Processing payment","amount":100,"requestId":"abc-123","userId":"user-456"}
```

### 4. 不同级别的日志

```typescript
// Trace - 最详细的调试信息
this.logger.trace('Variable state', { var1, var2 });

// Debug - 开发环境调试信息
this.logger.debug('Cache miss for key', { cacheKey });

// Info - 常规业务操作
this.logger.info('Order placed', { orderId, userId });

// Warn - 需要关注但不影响运行的情况
this.logger.warn('Slow query detected', { duration: 2500 });

// Error - 错误但程序仍可运行
this.logger.error('Payment failed', { error: error.message });

// Fatal - 致命错误,程序即将退出
this.logger.fatal('Database connection lost');
```

## 日志输出示例

### 开发环境(人类可读格式)

```
[2026-09-11 10:30:45.123] INFO: HTTP POST /api/users 201 45ms
    request: {
      "method": "POST",
      "url": "/api/users",
      "requestId": "req-abc-123"
    }
    response: {
      "statusCode": 201
    }
    responseTime: 45
```

### 生产环境(JSON 格式)

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

### 慢请求日志

```
[2026-09-11 10:30:45.123] WARN: HTTP GET /api/reports/export 200 3500ms [SLOW]
    request: {
      "method": "GET",
      "url": "/api/reports/export",
      "requestId": "req-slow-456"
    }
    responseTime: 3500
```

## 日志文件管理

### 文件结构

```
logs/
├── app.log          # 主日志文件
├── app.log.1.gz     # 轮转后的压缩文件
├── app.log.2.gz
├── ...
├── error.log        # 仅错误级别日志
└── error.log.1.gz
```

### 轮转策略

- 单个文件达到 `LOG_MAX_FILE_SIZE`(默认 10MB) 时自动轮转
- 保留最近 `LOG_MAX_FILES`(默认 7) 个文件
- 旧文件自动压缩为 `.gz` 格式(可配置)

## 性能优化建议

### 1. 生产环境启用 JSON 格式

JSON 格式比人类可读格式快 3-5 倍,且更容易被日志采集系统解析。

### 2. 合理设置日志级别

- 开发环境:`debug`
- 测试环境:`info`
- 生产环境:`info` 或 `warn`(高流量场景)

### 3. 避免在循环中记录详细日志

```typescript
// ❌ 不推荐
for (const item of items) {
  this.logger.debug('Processing item', { itemId: item.id });
}

// ✅ 推荐
this.logger.debug('Processing batch', { itemCount: items.length });
```

### 4. 使用对象而非字符串拼接

```typescript
// ❌ 不推荐
this.logger.info(`User ${userId} logged in from ${ip}`);

// ✅ 推荐(Pino 会高效序列化对象)
this.logger.info('User logged in', { userId, ip });
```

## 与日志采集系统集成

### ELK Stack (Elasticsearch + Logstash + Kibana)

Pino 的 JSON 输出可直接被 Logstash 解析:

```javascript
// logstash.conf
input {
  file {
    path => "/app/logs/app.log"
    codec => json
  }
}
```

### Grafana Loki

使用 `pino-loki` transport:

```bash
pnpm add pino-loki
```

```typescript
// logger.module.ts
transport: {
  targets: [
    {
      target: 'pino-loki',
      options: {
        host: 'http://loki:3100',
        labels: { app: 'my-app' },
      },
    },
  ],
}
```

### Datadog

Pino 原生支持 Datadog:

```bash
pnpm add pino-datadog
```

## 故障排查

### 问题 1: 日志未输出到文件

**检查点:**
1. 确认 `LOG_OUTPUT` 设置为 `file` 或 `both`
2. 确认 `LOG_DIR` 目录存在且有写权限
3. 查看控制台是否有权限错误

**解决方案:**
```bash
# 创建日志目录并设置权限
mkdir -p logs
chmod 755 logs
```

### 问题 2: 日志文件过大

**检查点:**
1. 确认 `LOG_MAX_FILE_SIZE` 配置正确
2. 确认日志轮转功能正常工作

**解决方案:**
手动清理旧日志文件:
```bash
# 删除 7 天前的日志
find logs/ -name "*.log.*" -mtime +7 -delete
```

### 问题 3: 生产环境日志太多

**解决方案:**
提高日志级别:
```bash
LOG_LEVEL=warn
```

或禁用调试日志:
```bash
# 在特定模块中过滤
LOG_FILTER_MODULES=UserService,AuthService
```

## 最佳实践

### 1. 始终记录关键业务操作

```typescript
✅ 用户登录/登出
✅ 支付/订单创建
✅ 权限变更
✅ 数据删除
✅ 外部 API 调用
```

### 2. 敏感信息脱敏

```typescript
// ❌ 不推荐 - 泄露密码
this.logger.info('Login attempt', { password: user.password });

// ✅ 推荐 - 只记录必要信息
this.logger.info('Login attempt', { 
  userId: user.id, 
  ip: request.ip 
});
```

### 3. 错误日志包含足够上下文

```typescript
// ❌ 不推荐
this.logger.error('Database error');

// ✅ 推荐
this.logger.error('Database query failed', {
  query: 'SELECT * FROM users WHERE id = ?',
  params: [userId],
  error: error.message,
  stack: error.stack,
});
```

### 4. 使用一致的日志格式

团队内统一日志字段命名:
- `userId` 而非 `user_id` 或 `uid`
- `requestId` 而非 `req_id`
- `responseTime` 而非 `duration`

## 迁移指南

### 从 NestJS Logger 迁移

原有代码:
```typescript
import { Logger } from '@nestjs/common';

private readonly logger = new Logger(UserService.name);
this.logger.log('Message');
```

新代码:
```typescript
import { PinoLogger } from 'nestjs-pino';

constructor(private readonly logger: PinoLogger) {}
this.logger.info('Message');
```

**注意:**
- `Logger.log()` → `logger.info()`
- `Logger.error()` → `logger.error()`
- `Logger.warn()` → `logger.warn()`
- `Logger.debug()` → `logger.debug()`

## 相关资源

- [Pino 官方文档](https://getpino.io/)
- [nestjs-pino GitHub](https://github.com/iamolegga/nestjs-pino)
- [结构化日志最佳实践](https://www.datadoghq.com/blog/best-practices-for-structured-logging/)
