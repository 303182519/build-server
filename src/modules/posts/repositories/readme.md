# 拿一个具体请求举例。假设：

- 关键词搜索：keyword = "hello"

- 状态过滤：status = "published"

- 游标指向：{ v: '2026-09-02T10:00:00.000Z', id: '100' }（sortBy = createdAt，order = desc）

- 没传 tag


## 第 1 步：baseWhere 先产出顶层条件

```sql
where = {
  OR: [
    { title: { contains: 'hello' } },
    { content: { contains: 'hello' } },
  ],
  status: 'published',
}
```

## 第 2 步：算 keyset

因为 order = desc，所以 op = 'lt'（取"更小/更早"的行）：

```sql
keyset = {
  OR: [
    { createdAt: { lt: new Date('2026-09-02T10:00:00.000Z') } },     // 条件①：更早的行
    { createdAt: new Date('...10:00:00...'), id: { lt: '100' } },    // 条件②：同一时刻、id 更小
  ],
}
```

## 第 3 步：第 161 行把它塞进 AND

```sql
where.AND = [keyset];
```

## 最终 where 长这样

```sql
{
  OR: [
    { title: { contains: 'hello' } },
    { content: { contains: 'hello' } },
  ],
  status: 'published',
  AND: [
    {
      OR: [
        { createdAt: { lt: new Date('2026-09-02T10:00:00.000Z') } },
        { createdAt: new Date('2026-09-02T10:00:00.000Z'), id: { lt: '100' } },
      ],
    },
  ],
}
```

## 翻译成 SQL 大概是

```sql
WHERE (
        title LIKE '%hello%' OR content LIKE '%hello%'   -- keyword 的 OR
      )
  AND status = 'published'                                 -- 状态过滤
  AND (
        createdAt <  '2026-09-02 10:00:00'                 -- keyset 条件①
        OR (createdAt = '2026-09-02 10:00:00' AND id < 100) -- keyset 条件②
      )
ORDER BY createdAt DESC, id DESC
LIMIT 21
```