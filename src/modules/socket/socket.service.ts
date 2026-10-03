import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { UserBasePayload } from '../users/users.service';

// 单用户最大并发连接数（多标签页 / 多设备）。超出时踢掉最早建立的连接，
// 防止单用户无限开连接造成内存占用与 user-joined / user-left 广播放大。
const MAX_SOCKETS_PER_USER = 10;

@Injectable()
export class SocketService {
  private readonly logger = new Logger(SocketService.name);

  // TODO: 当前使用内存 Map，仅适用于单实例部署。多实例需使用 @socket.io/redis-adapter
  private connectedClients = new Map<string, Set<Socket>>();

  handleConnection(client: Socket, user: UserBasePayload): void {
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

  getConnectedUserIds(): string[] {
    return Array.from(this.connectedClients.keys());
  }

  isConnected(userId: string): boolean {
    return this.connectedClients.has(userId);
  }

  /**
   * 向用户的所有活跃连接投递事件。
   * 返回是否至少投递给一个连接。封装 Socket 集合的持有与遍历，
   * 调用方不接触内部引用；多实例切换 Redis adapter 时仅需改造此处。
   */
  sendToUser(userId: string, event: string, payload: unknown): boolean {
    const sockets = this.connectedClients.get(userId);
    if (!sockets || sockets.size === 0) {
      return false;
    }
    for (const socket of sockets) {
      socket.emit(event, payload);
    }
    return true;
  }
}
