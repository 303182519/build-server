# Prisma 事务使用指南（@nestjs-cls/transactional）

> 配套架构决策：ADR-006。本文是日常开发的操作手册：怎么写事务、什么时候用
> `withTransaction`、什么时候用 `@Transactional()`、有哪些坑。

## 1. 三十秒理解原理

```
withTransaction(async () => {
  // ① 进入回调前：适配器调用 prisma.$transaction(...) 开启事务，
  //    把「事务客户端」存进 CLS（请求级的 AsyncLocalStorage）
  const tx = this.txHost.tx;   // ② 回调内任何地方取到的都是同一个事务客户端
  await tx.post.update(...);
  await this.someOtherService.doSomething();  // ③ 被调方法里 txHost.tx 也是它
}); // ④ 回调正常结束 → COMMIT；抛出异常 → ROLLBACK，异常原样向外抛
```

两个关键事实：

- **`txHost.tx` 是「当前上下文感知」的**：事务回调内 = 事务客户端；
  事务外（普通方法、定时任务、worker）= 自动回退为基座 `PrismaService`。
  同一个方法因此既能在事务里被调用，也能独立被调用——**不再需要把 tx 当参数传来传去**。
- **事务边界 = 回调/方法的边界**。提交与回滚由库接管，你不写 COMMIT/ROLLBACK。

## 2. 本项目已完成的配置（了解即可）

[context.module.ts](../src/common/context/context.module.ts) 里注册了一次插件：

```ts
new ClsPluginTransactional({
  imports: [PrismaModule],
  adapter: new TransactionalAdapterPrisma<PrismaService>({
    prismaInjectionToken: PrismaService,
    sqlFlavor: 'mysql', // 嵌套事务（RequiresNew）用 SAVEPOINT 实现所需的方言
  }),
})
```

业务代码使用事务只需两步：**注入 `TransactionHost` + 用 `txHost.tx` 读写**：

```ts
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { PrismaService } from '@/shared/database/prisma/prisma.service';

@Injectable()
export class SomeService {
  constructor(
    private readonly prisma: PrismaService, // 无事务的单条读写继续用它
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
  ) {}
}
```

## 3. 用法一：`withTransaction`（编程式，本项目默认）

### 3.1 基本骨架

```ts
return this.txHost.withTransaction(async () => {
  // 固定第一行：取当前事务客户端，回调内所有读写都走它
  const tx = this.txHost.tx;

  await tx.user.update({ ... });
  await tx.auditLog.create({ ... });
  return result;        // 返回值原样透出
});
// 回调里抛出的任何异常 → 事务回滚后原样向外抛，可在外层 catch 翻译
```

### 3.2 案例：更新文章 + 写修订快照（真实代码）

来自 [prisma-posts.repository.ts](../src/modules/posts/repositories/prisma-posts.repository.ts) ——
「改 post」与「写 postRevision 快照」必须同生共死：

```ts
private async updateOnce(id: bigint, data: Prisma.PostUpdateInput, expectedVersion?: number) {
  try {
    return await this.txHost.withTransaction(async () => {
      const tx = this.txHost.tx;

      let row;
      if (expectedVersion !== undefined) {
        // 乐观锁：WHERE id AND version = expected，命中 0 行抛 P2025
        row = await tx.post.update({
          where: { id, version: expectedVersion },
          data,
          select: postSelect,
        });
      } else {
        row = await tx.post.update({ where: { id }, data, select: postSelect });
      }

      // 同一事务里快照一条修订
      await tx.postRevision.create({ data: { /* ... */ } });
      return this.toDomain(row);
    });
  } catch (e) {
    // ★ 错误翻译放在 withTransaction 外面：此时事务已回滚，
    //   P2025（记录不存在）→ null；P2002（slug 撞名）→ 409 业务错误
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return null;
    if (this.isSlugConflict(e)) throw this.slugTaken();
    throw e;
  }
}
```

要点：**回滚与错误翻译分两层**——库里负责回滚，你在 `withTransaction` 外 `catch` 后按业务语义翻译异常，和旧 `$transaction` 写法完全同构。

### 3.3 案例：列表 findMany + count 同一事务快照（替代数组批读）

旧写法 `prisma.$transaction([findMany, count])` 的等价物：

```ts
// 来自 prisma-posts.repository.ts findMany / job-record.service.ts list
const [rows, total] = await this.txHost.withTransaction(() =>
  Promise.all([
    this.txHost.tx.post.findMany({ where, skip, take }),
    this.txHost.tx.post.count({ where }),
  ]),
);
```

MySQL 默认隔离级别（REPEATABLE READ）下，同一事务里两次 SELECT 看到同一快照，
`total` 与当页数据口径一致。单连接上查询本就串行执行，`Promise.all` 只是写法简洁。

### 3.4 案例：CPU 密集操作必须留在事务外（粒度控制）

来自 [users.service.ts](../src/modules/users/users.service.ts) `updatePasswordByAdmin`——
argon2 哈希约 50-100ms，包进事务会白白占用 DB 连接：

```ts
// 哈希在事务外：argon2 是 CPU 密集，放进事务会拉长 DB 连接占用
const hashedPassword = await hash(newPassword, { timeCost: 5 });

return this.txHost.withTransaction(async () => {
  const tx = this.txHost.tx;
  const result = await tx.user.updateMany({
    where: { id, deletedAt: null },
    data: { password: hashedPassword },
  });
  if (result.count === 0) throw new ErrorException(ErrorExceptionCode.USER_NOT_FOUND);
  return { message: 'Password updated successfully' };
});
```

### 3.5 带事务选项

第二签名可传 Prisma 事务选项（与 `prisma.$transaction(fn, options)` 相同）：

```ts
await this.txHost.withTransaction(
  { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 },
  async () => { /* ... */ },
);
```

## 4. 用法二：`@Transactional()` 装饰器（声明式）

你在别的项目看到的写法就是它。等价的声明式版本：

```ts
import { Transactional, Propagation } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { PrismaService } from '@/shared/database/prisma/prisma.service';

@Transactional<TransactionalAdapterPrisma<PrismaService>>()   // 整个方法体进事务
async updateUserRoles(id: bigint, roles: string[]) {
  const tx = this.txHost.tx;            // 取客户端的方式不变
  await tx.userRoles.deleteMany({ where: { userId: id } });
  await tx.userRoles.createMany({ data: ... });
}

// 带传播级别 / 事务选项：
@Transactional<TransactionalAdapterPrisma<PrismaService>>(Propagation.RequiresNew)
@Transactional<TransactionalAdapterPrisma<PrismaService>>({ timeout: 5000 })
```

### 装饰器的三个陷阱（必读）

1. **同类自调用不生效**。装饰器靠 DI 代理包装，`this.updateUserRoles(...)` 内部直调
   绕过代理 → 静默无事务。只有「别的类注入后调用」或「同实例经代理的入口方法」才触发。
2. **边界是整个方法**。方法里的 argon2 哈希、HTTP 调用、文件 IO 都会被包进事务、
   拉长连接占用——所以本项目的默认选择是 `withTransaction`，事务边界圈到哪由你显式决定。
3. **方法内仍然要用 `txHost.tx`**，装饰器只负责开关事务，不换你手里的客户端。

### 什么时候可以用装饰器

方法**全部**逻辑都该在同一事务里、且方法只被外部调用时，装饰器更简洁——
典型的如「纯编排的写方法」。本项目 ADR-006 不禁用，但要求逐个方法评估上述陷阱。

## 5. 跨 Service 协作：这才是它最大的价值

旧版 [refresh-token.service.ts](../src/modules/auth/refresh-token.service.ts) 为了
「rotate 里作废旧 token + 签发新 token 同一事务」，被迫给 `issue` 加透传参数：

```ts
// ❌ 旧写法：句柄透传，漏传就静默脱事务
async issue(user: User, client: Prisma.TransactionClient = this.prisma) { ... }
```

现在 `issue` 里没有事务参数，行为却两种场景都对：

```ts
// rotate：开启事务 → issue 内部的 txHost.tx 自动命中当前事务客户端
async rotate(rawRefresh: string) {
  return this.txHost.withTransaction(async () => {
    const tx = this.txHost.tx;
    await tx.refreshToken.updateMany({ ... });        // 作废旧的
    return { tokens: await this.issue(record.user) }; // 签发新的，自动加入本事务
  });
}

// login / register：不在任何事务里 → txHost.tx 回退为基座 PrismaService，独立提交
async login(dto: LoginDto) {
  // ...
  const tokens = await this.refreshTokenService.issue(user);
}
```

**规则：跨 Service 协作永远不再新增 `Prisma.TransactionClient` 类型的参数。**

## 6. 嵌套与传播（Propagation）

默认 `Propagation.Required`：已处于事务中 → 加入当前事务；否则 → 开新事务。
所以 `withTransaction` 套 `withTransaction`、`@Transactional` 方法调 `withTransaction`，
都安全地合并成**同一个**事务，不会报错也不会开重复事务。

```ts
import { Propagation } from '@nestjs-cls/transactional';

// RequiresNew（需配 sqlFlavor）= 同一事务里打 SAVEPOINT：
//   嵌套块成功 → RELEASE SAVEPOINT，改动合并进外层事务（不是独立提交！外层之后回滚，它照样消失）；
//   嵌套块抛错 → ROLLBACK TO SAVEPOINT，只撤掉嵌套块内的改动，外层可 catch 后继续。
// 典型场景：批量导入，单条失败只跳过该条、不影响整批：
await this.txHost.withTransaction(async () => {
  const failed: string[] = [];
  for (const name of names) {
    try {
      await this.txHost.withTransaction(Propagation.RequiresNew, async () => {
        await this.txHost.tx.tag.create({
          data: { id: BigInt(generateSnowflakeId()), name },
        });
      });
    } catch {
      failed.push(name); // 该条已回滚到 SAVEPOINT，循环继续
    }
  }
  return { failed };
}); // 外层事务提交：成功的留下，失败的不在
```

**注意：SAVEPOINT 不是独立事务**——`RELEASE SAVEPOINT` 只是「拔掉旗子」，整个过程中
只有外层事务末尾的 COMMIT 才真正落库；外层之后回滚，已 RELEASE 的改动照样消失。
所以「主业务回滚了、审计日志也要留住」这类需求不能用 RequiresNew（见下方 NotSupported）。

### 反例：去掉 RequiresNew，只靠 try/catch 行不行？

不行——一条失败，整批全灭：

```ts
await this.txHost.withTransaction(async () => {
  const failed: string[] = [];
  for (const name of names) {
    try {
      // 默认 Required：不开新事务、没有 SAVEPOINT，直接并入外层事务 T
      await this.txHost.withTransaction(async () => {
        await this.txHost.tx.tag.create({ ... }); // 撞唯一键抛 P2002
      }); // ★ 此刻 T 已被 Prisma 判死刑
    } catch {
      failed.push(name); // catch 接得住 JS 异常，救不活事务 T
    }
  }
  // 后续每轮 create 都在「已死」的 T 上执行 → 继续抛错 → 全部进 failed
  return { failed };
}); // 外层也无法正常提交：前面成功的同样陪葬，整批报废
```

原因：Prisma 的交互式事务**不允许「带伤继续」**——任何一条 query 抛错，整条事务就被
它回滚，之后在这条 tx 上的所有 query 都会报错。InnoDB 本身支持语句级回滚（单条
INSERT 失败只撤该语句），但 Prisma 不给你这个机会，这正是适配器要引入
`sqlFlavor` + SAVEPOINT 的原因。

一句话：**try/catch 决定「JS 流程能不能继续」，SAVEPOINT 决定「事务能不能继续」**——
批量跳过场景两个都需要，少一个都不行。

### NotSupported：挂起外层，独立结算

「挂起」= 外层事务原地暂停（连接仍被它占用、锁仍持有、未提交的改动悬在半空），
嵌套块被安排到**另一条数据库连接**上、**不在任何事务里**执行——每条 SQL autocommit，
执行完即永久落库。块结束后外层恢复执行，之后提交或回滚都与刚才的写入无关：

```ts
await this.txHost.withTransaction(async () => {
  const tx = this.txHost.tx;
  await tx.order.update({ where: { id }, data: { status: 'PAID' } });

  // 挂起外层事务：块内 txHost.tx 回退为基座 PrismaService（非事务客户端）
  await this.txHost.withTransaction(Propagation.NotSupported, async () => {
    await this.txHost.tx.auditLog.create({ data: { /* ... */ } }); // 立即独立提交
  });

  throw new Error('后续步骤失败'); // 外层整体回滚
});
// 结果：auditLog 留在库里，order.update 被撤销 —— 各算各的账
```

NotSupported 的三个坑：

1. **看不到外层未提交的改动**——两条连接两个世界，外层刚 `update` 但没提交的值，
   块内读到的是旧值；
2. **块内自己没有回滚保护**——块里有多条写、执行到一半挂了，前面已提交的撤不回来，
   会留半截数据；
3. **别去碰外层锁住/未提交的行**——你在等外层放锁，外层在挂起等你结束，
   自己把自己死锁。

分工：**RequiresNew（SAVEPOINT）要的是「局部可撤销」；NotSupported 要的是
「彻底脱离外层、独立结算」**。

其余级别（`Mandatory` 必须在事务内否则抛错、`Never` 必须不在事务内否则抛错）同上传入即可。

## 7. 本项目硬性规则（ADR-006 约束）

1. 新事务逻辑一律 `txHost.withTransaction`，**禁止再写裸 `prisma.$transaction`**；
2. 事务回调内所有 DB 读写必须走 `const tx = this.txHost.tx`，**禁止混用 `this.prisma`**；
3. 不要在事务外拿 `txHost.tx` 用就以为有事务——它只是回退成普通 client；
4. 单条无事务读写、`$executeRaw` 原子自增等，继续用注入的 `PrismaService`；
5. 错误翻译（P2025/P2002 → 业务异常）放在 `withTransaction` 的 `catch` 外层。

## 8. FAQ

**Q：BullMQ worker / seed 脚本里 `txHost.tx` 是什么？**
A：CLS 在非请求上下文不激活，`txHost.tx` 回退为基座 `PrismaService`，
与直接注入 `PrismaService` 行为一致。`withTransaction` 在非请求上下文也能正常用
（库内部会自行开启一个 CLS 上下文）。

**Q：只读查询要不要包事务？**
A：只有需要「多次读看到同一快照」时才包（如列表 findMany + count）。单条 `findUnique`
裸调 `this.prisma` 即可。

**Q：装饰器和 `withTransaction` 能混用吗？**
A：能。默认 `Required` 传播下，装饰器方法里再 `withTransaction` 会加入同一事务。

**Q：怎么确认回滚了？**
A：回调里抛出的任何异常都触发整体回滚，半条数据不会落库；异常回滚后原样向外抛，
外层照常 `catch` 处理（见 3.2）。

**Q：和 `@InjectTransaction()` 直接注入 tx 的写法呢？**
A：那是可选的第三种风格（`enableTransactionProxy: true` 才能用），本项目未开启，
统一用 `txHost.tx`，不要混用。

## 9. 速查表

| 场景 | 写法 |
|---|---|
| 多条写必须同生共死 | `withTransaction` 包精确边界 |
| 方法整个就是一件事、纯 DB 编排 | 可用 `@Transactional()`（注意自调用陷阱） |
| findMany + count 分页 | `withTransaction(() => Promise.all([...]))` |
| 哈希 / HTTP / 文件 IO | 放事务**外**，只把结果带进事务 |
| 跨 Service 协作 | 直接调，事务自动随 CLS 传播，不透传 tx |
| 单条读写、原子自增 | 注入的 `PrismaService`，不进事务 |
| 批量处理，单条失败要跳过（部分回滚） | `withTransaction(Propagation.RequiresNew, fn)`（SAVEPOINT） |
| 外层回滚也要留住审计日志等（独立结算） | `withTransaction(Propagation.NotSupported, fn)`（挂起外层，事务外写） |
