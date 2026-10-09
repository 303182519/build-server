#!/bin/bash

set -euo pipefail

VERSION="${1:?参数错误: 缺少新版本}"
OLD_VERSION="${2:?参数错误: 缺少旧版本}"

source ./config.sh

for VAR in ECS01_ID ECS01_HOST ECS02_ID ECS02_HOST LOAD_BALANCER_ID REGION_ID IMAGE ACR_REGISTRY ACR_USER ACR_PASS CONTAINER_NAME PORT; do
    if [ -z "${!VAR:-}" ]; then
        echo "错误: ${VAR} 未配置" >&2
        exit 1
    fi
done

log(){
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

#######################################
# 发布单台 ECS
#######################################

deploy_server(){

    SERVER_ID=$1
    SERVER_HOST=$2

    log "
        开始发布:
        服务器:
        $SERVER_HOST
        版本:
        $VERSION
    "

    ################################
    # 1. SLB摘流
    ################################

    log "1. 移除SLB流量"

    if ! ./slb-remove.sh "$SERVER_ID"; then
        log "SLB摘流失败"
        return 1
    fi

    ################################
    # 2. Docker部署
    ################################

    log "2. 更新Docker"
    if ! ./ssh-deploy.sh "$SERVER_HOST" "$VERSION"; then
        log "Docker部署失败,执行回滚"
        if rollback_server "$SERVER_HOST"; then
            ./slb-add.sh "$SERVER_ID" || log "警告:恢复SLB失败"
        else
            log "!!! 回滚失败 !!! 服务器:$SERVER_HOST 保持摘流,需人工介入"
        fi
        return 1
    fi

    ################################
    # 3. 健康检查
    ################################

    log "3. 健康检查"
    if ! ./health-check.sh "$SERVER_HOST"; then
        log "健康检查失败,执行回滚"
        if rollback_server "$SERVER_HOST"; then
            ./slb-add.sh "$SERVER_ID" || log "警告:恢复SLB失败"
        else
            log "!!! 回滚失败 !!! 服务器:$SERVER_HOST 保持摘流,需人工介入"
        fi
        return 1
    fi

    log "4. 恢复SLB流量"
    if ! ./slb-add.sh "$SERVER_ID"; then
        log "恢复SLB失败"
        return 1
    fi

    log "发布成功 服务器:$SERVER_HOST 版本:$VERSION"
}




#######################################
# 回滚
#######################################

rollback_server(){
    SERVER_HOST="$1"
    log "开始回滚 服务器:$SERVER_HOST 恢复版本:$OLD_VERSION"

    if ! ./rollback.sh "$SERVER_HOST" "$OLD_VERSION"; then
        log "!!! 回滚失败 !!! 需要人工介入 服务器:$SERVER_HOST"
        return 1
    fi

    log "回滚完成"
    return 0
}



#######################################
# 主流程
#######################################

trap 'log "发布被中断,请检查服务器状态与SLB流量"' INT TERM

log "================================= 开始发布 新版本:$VERSION 旧版本:$OLD_VERSION ================================="

if ! deploy_server "$ECS01_ID" "$ECS01_HOST"; then
    log "ECS01发布失败,停止后续发布"
    exit 1
fi

if ! deploy_server "$ECS02_ID" "$ECS02_HOST"; then
    log "ECS02发布失败,停止"
    exit 1
fi

log "================================= 全部发布完成 版本:$VERSION ================================="
