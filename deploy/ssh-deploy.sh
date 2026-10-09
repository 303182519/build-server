#!/bin/bash

set -e
HOST=$1
VERSION=$2

source ./config.sh

echo "部署服务器:$HOST"

ssh ${HOST} <<EOF

echo "登录ACR"
docker login \\
registry.cn-hangzhou.aliyuncs.com
echo "拉取镜像"

docker pull \\
${IMAGE}:${VERSION}

echo "停止旧容器"

docker stop ${CONTAINER_NAME} || true
docker rm ${CONTAINER_NAME} || true

echo "启动新版本"

docker run -d \\
--name ${CONTAINER_NAME} \\
-p ${PORT}:3000 \\
-e APP_VERSION=${VERSION} \\
--restart always \\
${IMAGE}:${VERSION}

echo "部署完成"
EOF