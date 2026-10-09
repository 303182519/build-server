#!/bin/bash

set -e
SERVER_ID=$1

source ./config.sh

echo "移除SLB节点:$SERVER_ID"

aliyun slb RemoveBackendServers \
--RegionId ${REGION_ID} \
--LoadBalancerId ${LOAD_BALANCER_ID} \
--BackendServers "
[
 {
  \"ServerId\":\"${SERVER_ID}\",
  \"Type\":\"ecs\"
 }
]
"

echo "SLB摘流完成"