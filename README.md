## Docker

项目内置了 Docker 支持，方便您快速启动和部署应用。


# 停止所有服务
docker compose down

# 停止并删除数据卷（⚠️ 清空数据库）
docker compose down -v

# 启动服务
docker compose up -d

# 重新构建镜像后启动（改了代码、Dockerfile、package.json 等）
docker compose up -d --build


# 进入 MySQL 查看数据
docker compose exec mysql mysql -u blog -p blog

# 查看迁移状态
docker compose logs migrate


# 日常发布，--build，seed 完全被忽略，不会构建、不会启动 ✅
docker compose up -d --build

# 需要跑种子数据的时候，手动带上 因为新增了profile-profiles: ["tools"] # 新增这一行
docker compose --profile tools up seed