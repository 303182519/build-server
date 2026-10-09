#!/bin/bash
set -euo pipefail

HOST="${1:?参数错误: 缺少 HOST}"
source ./config.sh

URL="http://${HOST#*@}:${PORT}${HEALTH_PATH}"

echo "检测: $URL"

MAX_RETRY="${HEALTH_MAX_RETRY}"
COUNT=0

while [ "$COUNT" -lt "$MAX_RETRY" ]
do
  STATUS=$(curl \
    -s \
    --connect-timeout "${HEALTH_CONNECT_TIMEOUT}" \
    --max-time "${HEALTH_MAX_TIME}" \
    -o /dev/null \
    -w "%{http_code}" \
    "$URL" || echo "000")

  if [ "$STATUS" = "200" ]; then
    echo "健康检查成功"
    exit 0
  fi

  COUNT=$((COUNT+1))
  echo "等待服务启动 $COUNT/$MAX_RETRY (HTTP $STATUS)"
  sleep "${HEALTH_INTERVAL}"
done

echo "健康检查失败"
exit 1