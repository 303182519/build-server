#!/bin/bash
set -euo pipefail

SERVER_ID="${1:?参数错误: 缺少 SERVER_ID}"

source ./config.sh

if [ -z "${ALIBABA_CLOUD_ACCESS_KEY_ID:-}" ]; then
    echo "错误: ALI_ACCESS_KEY 未配置" >&2
    exit 1
fi

echo "移除SLB节点:$SERVER_ID"

aliyun slb RemoveBackendServers \
  --RegionId "${REGION_ID}" \
  --LoadBalancerId "${LOAD_BALANCER_ID}" \
  --BackendServers "[{\"ServerId\":\"${SERVER_ID}\",\"Type\":\"ecs\"}]"

echo "等待SLB摘流生效与存量连接排空..."
COUNT=0
while [ "$COUNT" -lt "${SLB_DRAIN_MAX_RETRY}" ]; do
    sleep "${SLB_DRAIN_INTERVAL}"
    RESULT=$(aliyun slb DescribeLoadBalancerAttribute \
      --RegionId "${REGION_ID}" \
      --LoadBalancerId "${LOAD_BALANCER_ID}" 2>/dev/null || echo "{}")
    if echo "$RESULT" | grep -q "\"ServerId\":\"${SERVER_ID}\""; then
        COUNT=$((COUNT+1))
        echo "SLB仍在摘流 $COUNT/${SLB_DRAIN_MAX_RETRY}"
    else
        echo "SLB摘流完成"
        exit 0
    fi
done

echo "警告: SLB摘流超时,继续执行" >&2
exit 0