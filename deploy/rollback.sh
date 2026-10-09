#!/bin/bash
set -euo pipefail

HOST="${1:?参数错误: 缺少 HOST}"
VERSION="${2:?参数错误: 缺少 VERSION}"

source ./config.sh

if [ -z "${ACR_USER:-}" ] || [ -z "${ACR_PASS:-}" ]; then
    echo "错误: ACR_USER / ACR_PASS 未配置" >&2
    exit 1
fi

echo "开始回滚 服务器:$HOST 版本:$VERSION"

ssh ${SSH_OPTS} "${HOST}" <<EOF
set -euo pipefail

echo "登录ACR"
echo "${ACR_PASS}" | docker login "${ACR_REGISTRY}" -u "${ACR_USER}" --password-stdin

echo "拉取回滚镜像"
docker pull "${IMAGE}:${VERSION}"

echo "停止旧容器"
docker stop -t "${DOCKER_STOP_TIMEOUT}" "${CONTAINER_NAME}" || true
docker rm "${CONTAINER_NAME}" || true

echo "启动回滚版本"
docker run -d \\
  --name "${CONTAINER_NAME}" \\
  -p "${PORT}:3000" \\
  -e APP_VERSION="${VERSION}" \\
  --stop-timeout "${DOCKER_STOP_TIMEOUT}" \\
  --restart always \\
  "${IMAGE}:${VERSION}"

echo "校验回滚容器运行状态"
sleep 2
if ! docker ps --filter "name=${CONTAINER_NAME}" --filter "status=running" --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    echo "错误: 回滚容器未正常运行" >&2
    docker logs --tail 50 "${CONTAINER_NAME}" || true
    exit 1
fi

echo "回滚容器启动完成"
EOF

echo "回滚完成"