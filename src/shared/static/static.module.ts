import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Module({
  imports: [
    // 需要在 tsconfig.build.json 中排除 client 目录
    ServeStaticModule.forRoot({
      // rootPath: join(__dirname, '..', 'client'),
      // 使用 process.cwd() 获取当前工作目录路径
      rootPath: join(process.cwd(), 'client'),
      // 把 SPA 回退的范围从"所有 GET"收窄成"除了 /api/ 以外的 GET"。
      renderPath: /^(?!\/api\/).*/,
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
        setHeaders: (res, path) => {
          // html文件禁用长缓存，方便版本更新
          if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      },
    }),
  ],
})
export class StaticModule {}
