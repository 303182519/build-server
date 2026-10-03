import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { UserBasePayload } from '../users/users.service';

@Injectable()
export class SocketService {
	private readonly logger = new Logger(SocketService.name);

  // TODO: 当前使用内存 Map，仅适用于单实例部署。多实例需使用 @socket.io/redis-adapter
  private connectedClients = new Map<string, Set<Socket>>();

  handleConnection(client: Socket, user: UserBasePayload): void {
    if (!this.connectedClients.has(user.id.toString())) {
      this.connectedClients.set(user.id.toString(), new Set());
    }
    this.connectedClients.get(user.id.toString())!.add(client);
    this.logger.log('Socket client connected', {
      category: 'Socket',
      context: {
        socketId: client.id,
        userId: user.id.toString(),
        username: user.username,
      },
    });
  }

  handleDisconnect(client: Socket, user: UserBasePayload): void {
    const sockets = this.connectedClients.get(user.id.toString());
    if (sockets) {
      sockets.delete(client);
      if (sockets.size === 0) {
        this.connectedClients.delete(user.id.toString());
      }
    }
    this.logger.log('Socket client disconnected', {
      category: 'Socket',
      context: {
        socketId: client.id,
        userId: user.id.toString(),
        username: user.username,
      },
    });
  }

  getConnectedUserIds(): string[] {
    return Array.from(this.connectedClients.keys());
  }

  getUserSockets(userId: string): Set<Socket> | undefined {
    return this.connectedClients.get(userId);
  }

  isConnected(userId: string): boolean {
    return this.connectedClients.has(userId);
  }
}
