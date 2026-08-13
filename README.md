## Docker

项目内置了 Docker 支持，方便您快速启动和部署应用。

### 启动服务

1.  **创建 Docker 外部网络**
    所有 Compose 文件都复用 `my-nest-network`，需要先创建一次。

    ```bash
    docker network create my-nest-network
    ```

2.  **启动数据库服务**
    此命令会启动一个 PostgreSQL 数据库容器，并将数据持久化到 `docker内的pg-data` 目录。

    ```bash
    docker-compose -f docker-compose.db.yml up -d
    ```

3.  **启动 Redis 缓存服务**
    `docker-compose.app.yml` 和 `docker-compose.local.yml` 已配置 `REDIS_URL`。配置 Redis 连接后，应用启动时会校验 Redis 连通性。

    ```bash
    docker-compose -f docker-compose.cache.yml up -d
    ```

4.  **启动应用服务**
    - **方式一：通过 Compose 构建和运行**
      此命令会自动构建前后端，并启动应用容器。

      ```bash
      docker-compose -f docker-compose.app.yml up --build -d
      ```

    - **方式二：运行本地已构建的镜像**
      首先，您需要在项目根目录手动构建镜像：
      ```bash
      docker build -t my-first-nest:local .
      ```
      然后，使用 `local` compose 文件启动它：
      ```bash
      docker-compose -f docker-compose.local.yml up -d
      ```

### 停止服务

要停止所有服务并移除容器，请在项目根目录下运行：

```bash
# 停止并移除数据库
docker-compose -f docker-compose.db.yml down

# 停止并移除 Redis 缓存
docker-compose -f docker-compose.cache.yml down

# 停止并移除应用
docker-compose -f docker-compose.app.yml down
# 或者
docker-compose -f docker-compose.local.yml down
```