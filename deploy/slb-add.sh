#!/bin/bash

set -e
SERVER_ID=$1

source ./config.sh

echo "加入SLB:$SERVER_ID"


aliyun slb AddBackendServers \
--RegionId ${REGION_ID} \
--LoadBalancerId ${LOAD_BALANCER_ID} \
--BackendServers "
[
 {
  \"ServerId\":\"${SERVER_ID}\",
  \"Weight\":100,
  \"Type\":\"ecs\"
 }
]
"

echo "SLB恢复完成"