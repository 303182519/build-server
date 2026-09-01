**功能特性推导协议**

> 
> 该协议用于产品功能开发任务，一套标准化的功能设计分析流程

---

## 1. Requirement｜需求定义

Define:｜明确输出：

- user goal 用户目标
- success criteria 成功判定标准
- acceptance criteria 验收标准

## 2. Scope｜范围界定

Define:｜明确输出：

- in scope 纳入范围（本次要做）
- out of scope 排除范围（本次不做）
- affected modules 受影响模块

## 3. Existing Architecture｜现有架构调研

Inspect existing:｜梳理现有体系：

- frontend patterns 前端代码范式
- API patterns API 接口范式
- backend modules 后端模块
- database models 数据库模型
- cache patterns 缓存使用范式
- authorization 权限鉴权体系

> 
> Do not design in isolation.
> 禁止脱离现有架构，孤立做新功能设计。

## 4. State Ownership｜状态归属划分

Determine:｜判定划分：

- UI State UI 视图状态
- Client State 客户端状态
- Server State 服务端状态
- Derived State 派生 / 计算得出状态

Explicitly decide whether data belongs to:
明确数据归属载体：

- React React 组件本地状态
- Zustand Zustand 全局状态管理
- React Query React Query 服务端状态管理
- backend 后端服务
- database 数据库

## 5. API Contract｜接口契约设计

Define:｜定义：

- request 请求参数
- response 返回响应体
- errors 错误返回
- validation 参数校验规则
- authorization 鉴权权限要求

## 6. Business Invariants｜业务不变约束

Identify rules that must always remain true.
梳理**任何场景下都必须遵守**的业务规则（不可被打破的业务约束）。

## 7. Failure Design｜异常 / 故障场景设计

Consider:｜需考虑：

- network failure 网络异常
- timeout 请求超时
- retry 重试策略
- duplicate submission 重复提交
- authorization failure 鉴权失败
- stale data 脏 / 过期数据
- concurrency 并发问题
- partial failure 部分接口局部失败

## 8. Data Layer｜数据层影响评估

Determine whether the feature affects:
评估该功能会影响哪些数据组件：

- MySQL
- Prisma
- Redis
- external APIs 第三方外部接口

## 9. Implementation｜代码实现

Implement the smallest architecture‑consistent change.
做最小改动实现，保证和整体架构风格保持一致。

## 10. Validation｜验证校验

Validate:｜验证覆盖场景：

- happy path 正常主流程
- empty state 空数据状态
- failure state 异常失败状态
- permission boundaries 权限边界
- concurrency 并发场景
- relevant automated tests 配套自动化测试

## 11. Final Report｜最终输出报告

Report:｜报告输出项：

- Feature Scope 功能范围
- Architecture 架构说明
- Key Decisions 关键技术决策
- Risks 风险点
- Validation 验证情况