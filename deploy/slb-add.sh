#!/bin/bash
set -euo pipefail

SERVER_ID="${1:?参数错误: 缺少 SERVER_ID}"

source ./config.sh

if [ -z "${ALIBABA_CLOUD_ACCESS_KEY_ID:-}" ]; then
    echo "错误: ALI_ACCESS_KEY 未配置" >&2
    exit 1
fi

echo "加入SLB:$SERVER_ID"

aliyun slb AddBackendServers \
  --RegionId "${REGION_ID}" \
  --LoadBalancerId "${LOAD_BALANCER_ID}" \
  --BackendServers "[{\"ServerId\":\"${SERVER_ID}\",\"Weight\":100,\"Type\":\"ecs\"}]"

echo "SLB恢复完成"