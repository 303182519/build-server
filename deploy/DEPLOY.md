## Jenkins + Docker + 阿里云 SLB + NestJS 实现企业级零停机发布完整实战

> 阿里云 ECS × 2 + Docker + NestJS + Jenkins + ACR + SLB

目标：

- ✅ 用户无感发布
- ✅ 不停机
- ✅ 自动构建
- ✅ 自动部署
- ✅ 健康检查
- ✅ 失败自动回滚
- ✅ 保留历史版本

<br/>

生产中的核心思想：

> 永远不要直接替换正在提供服务的容器，而是先启动新版本，验证成功，再让 SLB 接流量。

这就是 Rolling Deployment（滚动发布）的思想。负载均衡负责摘除旧节点、等待连接结束、把流量切给新节点。

```
                 用户
                  |
                  |
              HTTPS 443
                  |
                  |
              阿里云 SLB
                  |
       +----------+----------+
       |                     |
       |                     |
    ECS-01                ECS-02
       |                     |
 Docker Container       Docker Container
       |                     |
 NestJS v1.0.2          NestJS v1.0.2
                  ^
                  |
                  |
              Jenkins

                  |
                  |
          Docker Build

                  |
                  |

             阿里云 ACR

```

## 二、一次完整发布发生什么？

假设现在线上：

```
ECS01
nestjs:v1.0.1

ECS02
nestjs:v1.0.1
```

开发提交：

```
git push

新增订单接口
```

目标：

```
nestjs:v1.0.2
```

流程：

```
Git Push
    |
    v
Jenkins
    |
    |
 docker build
    |
    |
 push ACR
    |
    |
部署 ECS01
    |
    |
健康检查
    |
    |
SLB恢复 ECS01
    |
    |
部署 ECS02
    |
    |
健康检查
    |
    |
完成
```

## 三、准备 NestJS 项目

目录：

```
deploy/

├── config.sh                 # 公共配置
├── deploy.sh                 # 发布入口
├── slb-remove.sh             # SLB摘流
├── slb-add.sh                # SLB恢复
├── ssh-deploy.sh             # ECS Docker更新
├── health-check.sh           # 健康检查
└── rollback.sh               # 回滚
```

## 四、Jenkins 安装阿里云 CLI

Jenkins 节点：
安装：

```sh
curl -O https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz

tar zxvf aliyun-cli-linux-latest-amd64.tgz

mv aliyun /usr/local/bin/
```

验证：

```
aliyun --version
```

## 五、配置 Jenkins Credentials

Jenkins:

```
Manage Jenkins
↓
Credentials
↓
Add Credentials
```

类型：

```
Secret text
```

保存：

```
ALI_ACCESS_KEY
ALI_SECRET_KEY
```

<br/>

### 公共配置 config.sh

所有脚本共享。

```sh
#!/bin/bash
# ======================
# 阿里云配置
# ======================
REGION_ID="cn-hangzhou"
LOAD_BALANCER_ID="lb-bpxxxxxxxx"

# ECS实例ID
ECS01_ID="i-bp111111"
ECS02_ID="i-bp222222"

# ======================
# Docker配置
# ======================
IMAGE="registry.cn-hangzhou.aliyuncs.com/company/nest-api"
CONTAINER_NAME="nest-api"
PORT=3000

# ======================
# SSH配置
# ======================
ECS01_HOST="root@47.xx.xx.1"
ECS02_HOST="root@47.xx.xx.2"

# ======================
# 健康检查
# ======================
HEALTH_PATH="/health"
```

### 入口 deploy.sh

Jenkins 最终只调用：

```sh
./deploy.sh 1024
```

代表发布：

```
nest-api:1024
```

<br/>

```sh
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

```

### SLB摘流 slb-remove.sh

> 把 ECS 从 SLB 后端移除。调用：

```sh
./slb-remove.sh i-bp111111
```

```
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
```

### SLB恢复 slb-add.sh

```
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
```

### ECS部署 ssh-deploy.sh

这个负责：

- ssh
- docker pull
- stop旧容器
- run新容器

```
./ssh-deploy.sh root@47.xx.xx.1 1024
```

```
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
```

### 健康检查 health-check.sh

生产不能：
docker run 成功 = 发布成功
必须验证业务。
调用：

```
./health-check.sh root@47.xx.xx.1
```

```sh
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
```

### 回滚 rollback.sh

例如：
当前：

```
v1.0.2
启动失败
```

恢复：

```
v1.0.1
```

调用：

```
./rollback.sh root@47.xx.xx.1 1023
```

```sh
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
```
