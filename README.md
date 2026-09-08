## Docker

项目内置了 Docker 支持，方便您快速启动和部署应用。


### 停止所有服务
docker compose down

### 停止并删除数据卷（⚠️ 清空数据库）
docker compose down -v

### 启动服务
docker compose up -d

### 重新构建镜像后启动（改了代码、Dockerfile、package.json 等）
docker compose up -d --build


### 进入 MySQL 查看数据
docker compose exec mysql mysql -u blog -p blog

### 查看迁移状态
docker compose logs migrate


### 日常发布，--build，seed 完全被忽略，不会构建、不会启动 ✅
docker compose up -d --build

### 需要跑种子数据的时候，手动带上 因为新增了profile-profiles: ["tools"] # 新增这一行
docker compose --profile tools up seed


# 发布更新操作
### 0. 发布前备份数据库！重中之重
docker compose exec mysql mysqldump -u root -p blog > backup_$(date +%Y%m%d_%H%M).sql

### 1. 更新代码
git pull

### 2. 预先构建镜像（这一步不会停服务！）
docker compose build api migrate

### 3. 执行更新，此时才会停止旧api，执行迁移，启动新api
docker compose up -d api migrate

### 4. 跟踪日志，观察迁移和启动
docker compose logs -f migrate api

### 5. 确认健康检查通过
docker compose ps
# api 状态显示 (healthy) 代表成功

### 6. 如需执行种子数据（新增角色/初始化数据才跑，日常升级不用）
# docker compose up seed
