# Nginx 示例：只转发 /api 业务路由，/api/health 不对外
```
server {
    location /api/health {
        # 仅允许内网探针网段
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        deny all;
        proxy_pass http://app:3000;
    }

    location /api/ {
        proxy_pass http://app:3000;
    }
}
```