## Bug 推理排查流程（协议）

> 
> 本协议用于处理 BUG 相关任务

### 1. Reproduce 复现问题

确认以下信息：

- expected behavior：预期行为
- actual behavior：实际发生的行为
- reproduction steps：复现步骤
- affected environment：受影响的环境

如果无法复现问题，需明确说明。

### 2. Trace 链路追踪

梳理执行链路：
`用户操作 → 前端 → 状态 → 接口API → 后端 → 数据库 / Redis / 外部服务 → 返回响应 → UI界面`

仅排查与该 BUG 相关的层级。

### 3. Establish Facts 确认客观事实

把**已证实的客观事实**和**主观猜测**做区分。

### 4. Form Hypotheses 提出假设

生成合理的根因猜想。
⚠️ 不要把猜想当成既定事实。

### 5. Collect Evidence 收集证据

可使用这些信息来源：

- source code 源代码
- tests 测试用例
- logs 日志
- reproduction 问题复现现象
- types 类型定义
- query behavior 查询执行行为
- network behavior 网络请求行为

### 6. Identify Root Cause 定位根本原因

不要只停留在表面现象。
自问：**系统为什么会允许出现这种异常状态？**

### 7. Minimum Safe Fix 最小安全修复

以改动最小、安全的方式修复问题根源。

### 8. Regression Analysis 回归影响分析

思考问题：

- 还有哪些业务路径会用到这段代码？
- 哪些原有假设会被改动打破？
- 是否存在竞态条件？
- 错误处理链路会产生哪些变化？

### 9. Validation 验证修复

新增或更新回归测试用例。
执行对应的自动化验证。

### 10. Final Report 最终问题报告

报告需包含：
Expected（预期行为）、Actual（实际现象）、Root Cause（根本原因）、Fix（修复方案）、Regression Risk（回归风险）、Validation（验证结果）

