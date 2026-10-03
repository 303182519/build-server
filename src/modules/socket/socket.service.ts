import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { UserBasePayload } from '../users/users.service';
import { SYSTEM_ROOM_PREFIX } from './dto';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from './interface/socket-event.types';

// 单实例单用户最大并发连接数（多标签页 / 多设备）。超出时踢掉最早建立的连接，
// 防止单用户无限开连接造成内存占用与 user-joined / user-left 广播放大。
//
// 多实例语义：该上限为「单节点」上限（集群总上限 = 节点数 × MAX_SOCKETS_PER_USER）。
// 跨节点的全局上限需要 Redis 原子计数 + 远程踢人协议，本期不引入；
// 私信投递与在线判断已通过 Redis adapter 实现跨实例正确。
const MAX_SOCKETS_PER_USER = 10;

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

/** 用户系统房间名：连接鉴权通过后由服务端自动加入，跨实例私信据此路由。 */
export const userRoom = (userId: string): string =>
  `${SYSTEM_ROOM_PREFIX}user:${userId}`;

@Injectable()
export class SocketService {
  private readonly logger = new Logger(SocketService.name);

  /**
   * 本节点连接注册表：仅记录本进程上的连接。
   * 用途：单节点连接数上限、跨实例查询前的本机快速路径、本机日志。
   * 集群范围内的房间成员关系由 Socket.IO adapter（Redis）维护，不存于此。
   */
  private connectedClients = new Map<string, Set<Socket>>();

  private server: TypedServer | null = null;

  /**
   * Gateway afterInit 时注入 Server。早于任何连接事件（listen 前调用），
   * 因此连接处理与业务推送发生时该引用必然就绪。
   */
  attachServer(server: TypedServer): void {
    this.server = server;
  }

  async handleConnection(client: Socket, user: UserBasePayload): Promise<void> {
    const userId = user.id.toString();
    let sockets = this.connectedClients.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.connectedClients.set(userId, sockets);
    }

    if (sockets.size >= MAX_SOCKETS_PER_USER) {
      // Set 保持插入序，最早加入的即最旧连接；其 disconnect 事件会异步
      // 触发 handleDisconnect 完成清理，此处无需手动移除。
      const oldest = sockets.values().next().value as Socket | undefined;
      if (oldest) {
        this.kickOldestSocket(oldest, userId);
      }
    }

    sockets.add(client);

    // 加入用户系统房间：RedisAdapter 房间成员按节点本地维护，加入仅写本机状态，
    // 不依赖 Redis 可用性；断开时 Socket.IO 自动退出房间，无需手动 leave。
    await client.join(userRoom(userId));

    this.logger.log('Socket client connected', {
      category: 'Socket',
      context: {
        socketId: client.id,
        userId,
        username: user.username,
      },
    });
  }

  /**
   * 踢掉超限用户最早的连接：尽力下发通知后强制断开。
   * 客户端收到 transport close 后由 socket.io 自动重连。
   */
  private kickOldestSocket(client: Socket, userId: string): void {
    this.logger.warn('Socket per-user connection limit exceeded', {
      category: 'Socket',
      context: {
        kickedSocketId: client.id,
        userId,
        limit: MAX_SOCKETS_PER_USER,
      },
    });
    client.emit('exception', {
      status: 429,
      message: '并发连接数已达上限',
    });
    client.disconnect(true);
  }

  handleDisconnect(client: Socket, user: UserBasePayload): void {
    const userId = user.id.toString();
    const sockets = this.connectedClients.get(userId);
    if (sockets) {
      sockets.delete(client);
      if (sockets.size === 0) {
        this.connectedClients.delete(userId);
      }
    }
    this.logger.log('Socket client disconnected', {
      category: 'Socket',
      context: {
        socketId: client.id,
        userId,
        username: user.username,
      },
    });
  }

  /**
   * 当前在本节点上有连接的用户 ID（本机视图，非集群全局）。
   * 全局在线列表需走 adapter 房间查询，当前无此业务需求，不做扩展。
   */
  getConnectedUserIds(): string[] {
    return Array.from(this.connectedClients.keys());
  }

  /**
   * 判断用户在集群内是否仍有活跃连接。
   *
   * 本机注册表命中可直接返回 true（零开销）；未命中时通过 Redis adapter
   * 向所有节点查询用户房间成员（allSockets 会等待各节点响应，5s 超时）。
   * Redis 不可用导致查询失败时降级为本机视图并记录告警——与单实例期行为一致，
   * 代价是 Redis 故障窗口内可能漏判其他节点上的连接。
   */
  async isConnected(userId: string): Promise<boolean> {
    if (this.connectedClients.has(userId)) {
      return true;
    }
    if (!this.server) {
      return false;
    }
    try {
      const sockets = await this.server.in(userRoom(userId)).allSockets();
      return sockets.size > 0;
    } catch (error) {
      this.logger.warn(
        `跨实例在线状态查询失败，降级为本机视图: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.connectedClients.has(userId);
    }
  }

  /**
   * 向用户在所有节点上的全部活跃连接投递事件（经 Redis adapter 路由）。
   *
   * 返回是否至少存在一个接收连接，供调用方决定离线降级（落库 / 稍后重试）：
   * - 本机有连接：必在线，直接投递；
   * - 本机无连接：查询用户房间的集群成员，为空则返回 false；
   * - 查询失败（Redis 故障）：无法确认远程在线状态，仍尽力投递（adapter
   *   无论 publish 成败都会执行本机广播）并按在线处理，避免本可送达的消息
   *   被误判丢弃；强可靠需求应由业务侧落库 / ack 兜底。
   */
  async sendToUser(
    userId: string,
    event: string,
    payload: unknown,
  ): Promise<boolean> {
    if (!this.server) {
      return false;
    }

    const room = userRoom(userId);
    if (!this.connectedClients.has(userId)) {
      try {
        const remoteSockets = await this.server.in(room).allSockets();
        if (remoteSockets.size === 0) {
          return false;
        }
      } catch (error) {
        this.logger.warn(
          `跨实例房间查询失败，按在线尽力投递: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // event / payload 为业务可扩展的动态事件，单点窄化到强类型 Server；
    // 房间名受 SYSTEM_ROOM_PREFIX 入参校验保护，外部连接无法进入该房间。
    this.server
      .to(room)
      .emit(event as keyof ServerToClientEvents, payload as never);
    return true;
  }
}
