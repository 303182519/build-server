#!/bin/bash

set -o pipefail


#######################################
# 参数
#######################################

VERSION=$1
OLD_VERSION=$2

if [ -z "$VERSION" ] || [ -z "$OLD_VERSION" ]
then
    echo "
    参数错误
    使用:
    ./deploy.sh 新版本 旧版本
    示例:
    ./deploy.sh 102 101
    "
    exit 1
fi

#######################################
# 加载配置
#######################################

source ./config.sh

#######################################
# 日志
#######################################

log(){
    echo "
    [$(date '+%Y-%m-%d %H:%M:%S')]
    $1
    "
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

    ./slb-remove.sh \
    $SERVER_ID

    if [ $? -ne 0 ]
    then
			log "SLB摘流失败"
			exit 1
    fi

    ################################
    # 2. Docker部署
    ################################

    log "2. 更新Docker"

    ./ssh-deploy.sh \
    $SERVER_HOST \
    $VERSION

    if [ $? -ne 0 ]
    then
      log "Docker部署失败"

    rollback_server \
    $SERVER_HOST

    ./slb-add.sh \
    $SERVER_ID

    exit 1
    fi

    ################################
    # 3. 健康检查
    ################################

    log "3. 健康检查"

    ./health-check.sh \
    $SERVER_HOST


    if [ $? -ne 0 ]
    then
        log "健康检查失败"

    rollback_server \
    $SERVER_HOST

    ./slb-add.sh \
    $SERVER_ID

    exit 1
    fi



    ################################
    # 4. 恢复SLB
    ################################

    log "4. 恢复SLB流量"

    ./slb-add.sh \
    $SERVER_ID

    if [ $? -ne 0 ]
    then
        log "恢复SLB失败"    
    exit 1
    fi


    log "
    发布成功:
    $SERVER_HOST
    版本:
    $VERSION
    "
}




#######################################
# 回滚
#######################################

rollback_server(){


    SERVER_HOST=$1

    log "
        开始回滚:    
        $SERVER_HOST
        恢复版本:
        $OLD_VERSION
    "

    ./rollback.sh \
    $SERVER_HOST \
    $OLD_VERSION

    if [ $? -ne 0 ]
    then
        log "
        !!! 回滚失败 !!!
        需要人工介入
        "
        exit 1
    fi

    log "回滚完成"
}



#######################################
# 主流程
#######################################

log "
=================================
开始发布
新版本:
$VERSION
旧版本:
$OLD_VERSION
=================================
"


#######################################
# 发布 ECS01
#######################################

deploy_server \

$ECS01_ID \

$ECS01_HOST

#######################################
# 发布 ECS02
#######################################

deploy_server \

$ECS02_ID \

$ECS02_HOST

log "

=================================
全部发布完成
版本:
$VERSION
=================================
"
