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
