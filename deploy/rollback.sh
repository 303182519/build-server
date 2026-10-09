#!/bin/bash


set -e

HOST=$1
VERSION=$2

source ./config.sh


echo "
开始回滚
服务器:
$HOST
版本:
$VERSION
"


ssh ${HOST} <<EOF

docker stop ${CONTAINER_NAME} || true
docker rm ${CONTAINER_NAME} || true

docker pull \\
${IMAGE}:${VERSION}

docker run -d \\
--name ${CONTAINER_NAME} \\
-p ${PORT}:3000 \\
-e APP_VERSION=${VERSION} \\
--restart always \\
${IMAGE}:${VERSION}

EOF

echo "回滚完成"