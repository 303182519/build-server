#!/bin/bash
# ======================
# 阿里云配置
# ======================
REGION_ID="cn-hangzhou"
LOAD_BALANCER_ID="lb-bpxxxxxxxx"

# ECS实例ID
ECS01_ID="i-bp111111"
ECS02_ID="i-bp222222"

# ======================
# Docker配置
# ======================
IMAGE="registry.cn-hangzhou.aliyuncs.com/company/nest-api"
CONTAINER_NAME="nest-api"
PORT=3000

# ======================
# SSH配置
# ======================
ECS01_HOST="root@47.xx.xx.1"
ECS02_HOST="root@47.xx.xx.2"

# ======================
# 健康检查
# ======================
HEALTH_PATH="/health"