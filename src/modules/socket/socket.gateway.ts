import {
  toWsErrorResponse,
  WsExceptionFilter,
} from '@/common/filters/ws-exception.filter';
import { WsJwtGuard } from '@/common/guards/ws-jwt.guard';
import {
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
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
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
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;
  private readonly logger = new Logger(SocketGateway.name);

  constructor(
    private readonly socketService: SocketService,
    private readonly wsJwtGuard: WsJwtGuard,
  ) {}

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

    this.socketService.handleConnection(client, user);
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

  handleDisconnect(client: AuthSocket): void {
    const { user } = client;
    if (user) {
      this.socketService.handleDisconnect(client, user);
      // 多标签页/多设备：仅当该用户已无任何活跃连接时才广播下线，
      // 否则关闭一个标签页会造成“假离线”（其他连接仍可正常收发消息）。
      if (!this.socketService.isConnected(user.id.toString())) {
        this.server.emit('user-left', {
          userId: user.id.toString(),
          username: user.username,
        });
      }
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
  handleSendToUser(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: SendToUserDto,
  ): AckResponse {
    const { user } = client;
    if (!user) return { success: false, message: 'Not authenticated' };

    const payload = {
      message: data.message,
      senderId: user.id.toString(),
      senderUsername: user.username,
      timestamp: new Date().toISOString(),
    };

    // Socket 集合的持有与遍历下沉到 Service，Gateway 不接触内部引用；
    // 多实例切换 Redis adapter 时仅需改造 SocketService。
    const delivered = this.socketService.sendToUser(
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
