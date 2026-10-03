import {
  toWsErrorResponse,
  WsExceptionFilter,
} from '@/common/filters/ws-exception.filter';
import { WsJwtGuard } from '@/common/guards/ws-jwt.guard';
import {
  Inject,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import { Namespace } from 'socket.io';
import { UserBasePayload } from '../users/users.service';
import {
  BroadcastDto,
  JoinRoomDto,
  LeaveRoomDto,
  SendToRoomDto,
  SendToUserDto,
} from './dto';
import { AuthSocket } from './interface/auth-socket';
import {
  AckResponse,
  ClientToServerEvents,
  ServerToClientEvents,
} from './interface/socket-event.types';
import {
  SOCKET_IO_REDIS_CLIENTS,
  type SocketIoRedisClients,
} from './socket-redis.clients';
import { SocketService } from './socket.service';

// 鉴权失败后的宽限期：期间等待客户端读取 exception 事件 / 回 ack，
// 超时后强制断开，保证未认证连接不悬挂占用服务端资源。
const AUTH_DISCONNECT_GRACE_MS = 5_000;

@UseGuards(WsJwtGuard)
@UseFilters(WsExceptionFilter)
@UsePipes(new ValidationPipe({ whitelist: true }))
@WebSocketGateway({
  namespace: '/socket',
  // 生产环境请改为具体域名 URL，如 cors: { origin: ['https://example.com'] }
  cors: { origin: '*' },
})
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  // IoAdapter 对声明了 namespace 的网关注入的是 Namespace（io.of('/socket')），
  // 而非根 Server；房间按命名空间隔离，投递/查询都必须限定在该命名空间内。
  server!: Namespace<ClientToServerEvents, ServerToClientEvents>;
  private readonly logger = new Logger(SocketGateway.name);

  constructor(
    private readonly socketService: SocketService,
    private readonly wsJwtGuard: WsJwtGuard,
    @Inject(SOCKET_IO_REDIS_CLIENTS)
    private readonly redisClients: SocketIoRedisClients | null,
  ) {}

  /**
   * Server 创建后、开始接受连接前执行（NestJS 在 listen 前调用）：
   * - 配置了 Redis：安装 Redis adapter，广播 / 房间 / 私信跨实例路由；
   * - 未配置 Redis：保持默认内存 adapter，仅支持单实例，启动告警提示。
   *
   * ioredis 连接为后台懒重连，此处不等待 Redis 可用：Redis 抖动期
   * 连接建立与本机投递不受影响，跨节点消息在恢复后自动继续。
   */
  afterInit(server: Namespace<ClientToServerEvents, ServerToClientEvents>): void {
    this.socketService.attachServer(server);

    if (!this.redisClients) {
      this.logger.warn(
        'Redis 未配置，Socket.IO 运行在单实例内存模式，多副本部署将无法跨实例投递',
      );
      return;
    }

    const { pubClient, subClient, channelKey } = this.redisClients;
    // Redis adapter 只能安装在根 Server 上（Namespace 无 adapter() 方法）。
    // Server#adapter() 会为所有已存在的命名空间（含先于此处创建的 /socket）
    // 重建 adapter，因此调用时点在 .of('/socket') 之后依然生效。
    server.server.adapter(
      createAdapter(pubClient, subClient, {
        // 隔离 pub/sub channel：多项目 / 多环境共用同一 Redis 时互不串消息
        key: channelKey,
        // 官方推荐项：响应只回给请求节点，下一大版本将成为默认值
        publishOnSpecificResponseChannel: true,
      }),
    );
    this.logger.log(
      `Socket.IO Redis adapter 已启用 (channel prefix: ${channelKey})`,
    );
  }

  async handleConnection(client: AuthSocket): Promise<void> {
    let user: UserBasePayload;
    try {
      // @UseGuards 对 handleConnection 不生效，此处手动调用共享鉴权逻辑。
      user = await this.wsJwtGuard.authenticateClient(client);
    } catch (error) {
      const response = toWsErrorResponse(error);
      this.logger.warn('Socket authentication failed', {
        category: 'Socket',
        context: {
          socketId: client.id,
          response,
        },
      });
      // 通过 ack 回调确保 exception 事件写入后再断开，否则客户端可能收不到
      // 401 状态码，无法触发 token 刷新逻辑。
      // 兜底：客户端若不回 ack（恶意/异常客户端），宽限期后强制断开，
      // 避免未认证连接悬挂并反复触发消息级鉴权（含数据库查询）。
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        client.disconnect(true);
      };
      const timer = setTimeout(close, AUTH_DISCONNECT_GRACE_MS);
      client.emit('exception', response, close);
      return;
    }

    await this.socketService.handleConnection(client, user);
    this.logger.log('Socket client connected', {
      category: 'Socket',
      context: {
        socketId: client.id,
        userId: user.id.toString(),
        username: user.username,
      },
    });

    client.emit('connected', {
      message: `Welcome, ${user.username}!`,
      userId: user.id.toString(),
      username: user.username,
    });

    client.broadcast.emit('user-joined', {
      userId: user.id.toString(),
      username: user.username,
    });
  }

  async handleDisconnect(client: AuthSocket): Promise<void> {
    const { user } = client;
    if (!user) return;

    this.socketService.handleDisconnect(client, user);
    // 多标签页/多设备/多实例：仅当该用户在集群内已无任何活跃连接时才广播下线，
    // 否则关闭一个标签页（或连接漂移到其他节点）会造成“假离线”。
    // isConnected 未命中本机时经 Redis adapter 查询其他节点；查询失败降级本机视图。
    if (!(await this.socketService.isConnected(user.id.toString()))) {
      this.server.emit('user-left', {
        userId: user.id.toString(),
        username: user.username,
      });
    }
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: JoinRoomDto,
  ): Promise<AckResponse> {
    const { user } = client;
    if (!user) return { success: false, message: 'Not authenticated' };

    await client.join(data.room);
    this.logger.log('Socket room joined', {
      category: 'Socket',
      context: {
        socketId: client.id,
        username: user.username,
        room: data.room,
      },
    });

    client.emit('room-joined', { room: data.room });
    client.to(data.room).emit('room-user-joined', {
      room: data.room,
      userId: user.id.toString(),
      username: user.username,
    });

    return { success: true };
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @SubscribeMessage('leave-room')
  async handleLeaveRoom(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: LeaveRoomDto,
  ): Promise<AckResponse> {
    const { user } = client;
    if (!user) return { success: false, message: 'Not authenticated' };

    await client.leave(data.room);
    this.logger.log('Socket room left', {
      category: 'Socket',
      context: {
        socketId: client.id,
        username: user.username,
        room: data.room,
      },
    });

    client.emit('room-left', { room: data.room });
    client.to(data.room).emit('room-user-left', {
      room: data.room,
      userId: user.id.toString(),
      username: user.username,
    });

    return { success: true };
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @SubscribeMessage('send-to-room')
  handleSendToRoom(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: SendToRoomDto,
  ): AckResponse {
    const { user } = client;
    if (!user) return { success: false, message: 'Not authenticated' };

    client.to(data.room).emit('room-message', {
      room: data.room,
      message: data.message,
      senderId: user.id.toString(),
      senderUsername: user.username,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @SubscribeMessage('send-to-user')
  async handleSendToUser(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: SendToUserDto,
  ): Promise<AckResponse> {
    const { user } = client;
    if (!user) return { success: false, message: 'Not authenticated' };

    const payload = {
      message: data.message,
      senderId: user.id.toString(),
      senderUsername: user.username,
      timestamp: new Date().toISOString(),
    };

    // Socket 集合的持有与遍历下沉到 Service，Gateway 不接触内部引用；
    // Service 经用户系统房间 + Redis adapter 完成跨实例投递。
    const delivered = await this.socketService.sendToUser(
      data.targetUserId,
      'direct-message',
      payload,
    );
    if (!delivered) {
      return { success: false, message: 'Target user is not connected' };
    }

    return { success: true };
  }

  // 广播会放大为 N-1 倍流量，限流最严格：60 秒内最多 5 次。
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @SubscribeMessage('broadcast')
  handleBroadcast(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: BroadcastDto,
  ): AckResponse {
    const { user } = client;
    if (!user) return { success: false, message: 'Not authenticated' };

    client.broadcast.emit('broadcast-message', {
      message: data.message,
      senderId: user.id.toString(),
      senderUsername: user.username,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }
}
