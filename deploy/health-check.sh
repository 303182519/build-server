#!/bin/bash


HOST=$1
source ./config.sh

URL="http://${HOST#*@}:${PORT}${HEALTH_PATH}"

echo "检测:
$URL"

MAX_RETRY=30

COUNT=0

while [ $COUNT -lt $MAX_RETRY ]
do

  STATUS=$(curl \
  -s \
  -o /dev/null \
  -w "%{http_code}" \
  $URL)
  
  
  if [ "$STATUS" = "200" ]
  then
  echo "
  健康检查成功
  "
  exit 0
  fi
  
  
  COUNT=$((COUNT+1))
  
  echo "等待服务启动 $COUNT/$MAX_RETRY"
  sleep 5
done

echo "
健康检查失败
"
exit 1