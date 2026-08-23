import { User } from '@prisma/client';
import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { JWT_META_KEY } from '../decorators/jwt-auth.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext, // https://docs.nestjs.cn/fundamentals/execution-context#executioncontext-%E7%B1%BB
  ): boolean | Promise<boolean> | Observable<boolean> {
    // 跳过 WebSocket 上下文，由 WsJwtGuard 处理
    if (context.getType() === 'ws') {
      return true;
    }

    const jwtMeta = this.reflector.getAllAndOverride<boolean>(JWT_META_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (jwtMeta) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser = User>(
    err: any,
    user: User | undefined,
    info: any,
    // context: ExecutionContext,
    // status?: any,
  ): TUser {

    console.log('-------------JwtAuthGuard-------------');
    console.log('err:', err);
    console.log('user:', user?.username);
    console.log('info:', info);
    console.log('--------------------------------------');
    
    if (err) {
      throw err;
    }

    if (!user) {
      const message =
        info instanceof Error
          ? info.message
          : typeof info === 'string'
            ? info
            : 'Unauthorized';
      throw new UnauthorizedException(message);
    }

    return user as TUser;
  }
}
