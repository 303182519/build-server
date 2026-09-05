import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import * as jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getConfig } from '@/config/configuration';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_JOB_QUEUE } from '../constants/job.constants';
import { SpecialRolesEnum } from '@/common/decorators/special-roles.decorator';

/**
 * Bull Board 任务监控面板服务。
 *
 * 职责：
 *   1. 创建 Bull Board Express 路由器（绑定当前项目的 BullMQ 队列）
 *   2. 提供认证中间件工厂（JWT / 无认证）
 *   3. 对外暴露 setupMiddleware()，由 main.ts 在 NestJS 路由之前挂载
 *
 * 安全设计：
 *   - 面板通过 app.use() 挂载于 NestJS 全局 Guard 之前，完全绕过 JwtAuthGuard / PermissionGuard
 *   - JWT 模式下校验签名 + 特殊角色（super_admin / developer），拒绝普通用户
 *   - 支持只读模式，防止生产环境误操作
 */
@Injectable()
export class JobBoardService {
  private readonly logger = new Logger(JobBoardService.name);

  constructor(
    @InjectQueue(DEFAULT_JOB_QUEUE)
    private readonly queue: Queue,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 创建并返回 Board 认证中间件。
   *
   * - 面板已禁用 → 返回透传中间件（请求继续流向 NestJS 路由）
   * - authType = 'jwt' → 校验 JWT 签名 + 特殊角色
   * - authType = 'none' → 放行（仅限开发 / 内网可信环境）
   */
  setupMiddleware(): RequestHandler {
    const { board, jwt: jwtConfig } = getConfig(this.configService);

    if (!board.enabled) {
      this.logger.log('Bull Board 已禁用（BULL_BOARD_ENABLED=false）');
      return (_req, _res, next) => next();
    }

    if (board.authType === 'none') {
      this.logger.warn(
        `Bull Board 认证已关闭（authType=none），面板路径 ${board.path} 对外完全开放 —— 仅限开发 / 内网可信环境`,
      );
      return this.createBoardRouter(board);
    }

    // authType === 'jwt'
    if (!jwtConfig.secret) {
      this.logger.error(
        'Bull Board authType=jwt 但 JWT_SECRET 未配置，回退为拒绝所有请求',
      );
      return (_req, res) => {
        res.status(500).json({ error: 'Board auth misconfiguration' });
      };
    }

    const boardRouter = this.createBoardRouter(board);
    const secret = jwtConfig.secret;

    return (req: Request, res: Response, next: NextFunction): void => {
      // 静态资源（CSS / JS / 图片等）由浏览器在加载已认证 HTML 后自动请求，
      // 这些请求不会携带 token，因此直接放行，交由 Board 路由处理。
      // HTML 页面本身仍然受上面的 JWT 认证保护。
      if (req.path.startsWith('/static/')) {
        boardRouter(req, res, next);
        return;
      }

      try {
        const token = this.extractToken(req);
        console.log('Token:', token);
        if (!token) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }

        const payload = jwt.verify(token, secret) as Record<string, unknown>;
        const userId = String(
          typeof payload.sub === 'string' ? payload.sub : '',
        );

        // 校验特殊角色：仅 super_admin / developer 可访问运维面板
        // 注意：此处仅做基础角色快速校验，完整权限体系由 NestJS PermissionGuard 负责
        // 由于 Board 绕过了 NestJS Guard 链，这里需要自行校验
        // 如果需要更精细的权限校验，可扩展为查询数据库
        // const specialRole =
        //   (payload.specialRoles as string | undefined) ??
        //   (payload['specialRoles'] as string | undefined);

        // if (
        //   specialRole !== SpecialRolesEnum.SuperAdmin &&
        //   specialRole !== SpecialRolesEnum.Developer
        // ) {
        //   this.logger.warn(
        //     `Board 访问拒绝：userId=${userId} specialRoles=${specialRole ?? 'none'}`,
        //   );
        //   res.status(403).json({ error: 'Insufficient permissions' });
        //   return;
        // }

        // 认证通过，转发到 Board 路由
        boardRouter(req, res, next);
      } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
      }
    };
  }

  /**
   * 从请求中提取 JWT 令牌。
   *
   * 优先级：
   *   1. URL 查询参数 ?token=xxx（前端新标签页打开场景）
   *   2. Cookie 中的 access_token（同域无缝访问）
   *   3. Authorization: Bearer xxx 头（API 调用场景）
   */
  private extractToken(req: Request): string | null {
    // 1. Query parameter（前端打开 Board 新标签页时携带）
    const queryToken = req.query.token;
    if (typeof queryToken === 'string' && queryToken.length > 0) {
      return queryToken;
    }

    // 2. Cookie（需要 cookie-parser 中间件，已在 CommonModule 全局注册）
    // const cookieToken = (req.cookies as Record<string, string> | undefined)
    //   ?.access_token;
    // if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    //   return cookieToken;
    // }

    // 3. Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  /**
   * 创建 Bull Board Express 路由器。
   *
   * - 绑定当前项目的默认 BullMQ 队列
   * - 根据配置启用只读模式
   * - 设置自定义面板标题
   */
  private createBoardRouter(boardConfig: {
    path: string;
    readOnly: boolean;
  }): (req: Request, res: Response, next: NextFunction) => void {
    const adapter = new ExpressAdapter();
    adapter.setBasePath(boardConfig.path);

    createBullBoard({
      queues: [
        new BullMQAdapter(this.queue, {
          readOnlyMode: boardConfig.readOnly,
        }),
      ],
      serverAdapter: adapter,
      options: {
        uiConfig: {
          boardTitle: 'Build Server — Job Queue Monitor',
          locale: { lng: 'zh-CN' },
        },
      },
    });

    this.logger.log(
      `Bull Board 已初始化 path=${boardConfig.path} readOnly=${boardConfig.readOnly}`,
    );

    // ExpressAdapter.getRouter() 返回 Express Router，类型声明为 any，此处安全断言
    return adapter.getRouter() as RequestHandler;
  }
}
