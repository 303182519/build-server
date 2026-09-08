#!/bin/sh
# 设置当脚本执行过程中，如果出现错误，则立即退出，避免继续执行
set -e

# ── 数据库迁移 ──────────────────────────────────────────────────────
# 应用启动前执行所有待处理的数据库迁移。
# prisma migrate deploy 是幂等的：已执行的迁移会被跳过，不会重复执行。
# 多实例同时启动时，MySQL 行锁保证同一时刻只有一个实例在执行迁移 SQL，
# 其余实例等待或跳过——安全。
# set -e 确保迁移失败时立即退出，不启动应用——避免代码与 schema 不匹配。
echo "[entrypoint] Running database migrations..."
pnpm exec prisma migrate deploy
echo "[entrypoint] Migrations complete. Starting application..."

# 执行 CMD 传入的命令（node dist/main）。
# exec 替换当前 shell 进程，确保 Node 成为 tini 的直接子进程，
# 信号（SIGTERM）能正确送达，优雅关闭正常工作。
exec "$@"
