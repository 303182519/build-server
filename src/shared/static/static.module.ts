import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Module({
  imports: [
    // 需要在 tsconfig.build.json 中排除 client 目录
    ServeStaticModule.forRoot(
      {
        // rootPath: join(__dirname, '..', 'client'),
        // 使用 process.cwd() 获取当前工作目录路径
        rootPath: join(process.cwd(), 'client'),
        // 把 SPA 回退的范围从"所有 GET"收窄成"除了 /api/ 和 /uploads/ 以外的 GET"。
        // 避免 /uploads/xxx.jpg 被 SPA 回退吞掉返回 index.html。
        // path-to-regexp v8 通配符语法：{*splat}（不再支持 (.*)）
        exclude: ['/api/{*splat}', '/uploads/{*splat}'],
        serveStaticOptions: {
          cacheControl: true,
          maxAge: '30d',
          immutable: true,
          etag: true,
          lastModified: true,
          dotfiles: 'ignore',
          fallthrough: true,
          index: 'index.html',
          preCompressed: true,
          setHeaders: (res, path: string) => {
            // html文件禁用长缓存，方便版本更新
            if (path.endsWith('.html')) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
              res.setHeader('Cache-Control', 'no-cache');
            }
          },
        },
      },
      {
        // 用户上传文件（封面图等）的静态服务。
        // serveRoot 与 StorageConfig.publicPrefix 对齐：
        //   LocalStorageService.publicUrl(key) 拼出的 URL 前缀 = publicPrefix
        //   这里把 publicPrefix 路径映射到 storage.localDir 目录，express 直接服务。
        rootPath: join(
          process.cwd(),
          // 默认 'uploads'，由 STORAGE_LOCAL_DIR 环境变量控制
          process.env.STORAGE_LOCAL_DIR || 'uploads',
        ),
        serveRoot: process.env.STORAGE_PUBLIC_PREFIX || '/uploads',
        serveStaticOptions: {
          cacheControl: true,
          maxAge: '365d',
          immutable: true,
          etag: true,
          dotfiles: 'ignore',
          fallthrough: true,
        },
      },
    ),
  ],
})
export class StaticModule {}
