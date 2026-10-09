#!/bin/bash
# ======================
# 阿里云配置
# ======================
REGION_ID="${REGION_ID:-cn-hangzhou}"
LOAD_BALANCER_ID="${LOAD_BALANCER_ID:-lb-bpxxxxxxxx}"

# ECS实例ID
ECS01_ID="${ECS01_ID:-i-bp111111}"
ECS02_ID="${ECS02_ID:-i-bp222222}"

# 阿里云访问凭证(由Jenkins环境变量注入)
export ALIBABA_CLOUD_ACCESS_KEY_ID="${ALI_ACCESS_KEY:-}"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="${ALI_SECRET_KEY:-}"

# ======================
# Docker配置
# ======================
IMAGE="registry.cn-hangzhou.aliyuncs.com/company/nest-api"
CONTAINER_NAME="nest-api"
PORT=3000

# ACR凭证(由Jenkins环境变量注入)
ACR_REGISTRY="registry.cn-hangzhou.aliyuncs.com"
ACR_USER="${ACR_USER:-}"
ACR_PASS="${ACR_PASS:-}"

# Docker优雅停止超时(秒)
DOCKER_STOP_TIMEOUT=30

# ======================
# SSH配置
# ======================
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"
ECS01_HOST="${ECS01_HOST:-root@47.xx.xx.1}"
ECS02_HOST="${ECS02_HOST:-root@47.xx.xx.2}"

# ======================
# 健康检查
# ======================
HEALTH_PATH="/health"
HEALTH_MAX_RETRY=30
HEALTH_INTERVAL=5
HEALTH_CONNECT_TIMEOUT=3
HEALTH_MAX_TIME=5

# ======================
# SLB摘流后连接排空(drain)轮询
# ======================
SLB_DRAIN_MAX_RETRY=12
SLB_DRAIN_INTERVAL=5