import { AppConfigModule } from '@/config/config.module';
import { getConfig } from '@/config/configuration';
import { WsExceptionFilter } from '@/common/filters/ws-exception.filter';
import { WsJwtGuard } from '@/common/guards/ws-jwt.guard';
import { Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { SocketGateway } from './socket.gateway';
import {
  closeSocketIoRedisClients,
  createSocketIoRedisClients,
  SOCKET_IO_REDIS_CLIENTS,
  type SocketIoRedisClients,
} from './socket-redis.clients';
import { SocketService } from './socket.service';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { jwt } = getConfig(configService);
        return {
          secret: jwt.secret,
          signOptions: { expiresIn: jwt.accessExpiresIn },
        };
      },
    }),
  ],
  providers: [
    SocketGateway,
    SocketService,
    WsExceptionFilter,
    WsJwtGuard,
    {
      provide: SOCKET_IO_REDIS_CLIENTS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { redis } = getConfig(configService);
        return createSocketIoRedisClients(redis);
      },
    },
  ],
  exports: [SocketService],
})
export class SocketModule implements OnModuleDestroy {
  private readonly logger = new Logger(SocketModule.name);

  constructor(
    @Inject(SOCKET_IO_REDIS_CLIENTS)
    private readonly redisClients: SocketIoRedisClients | null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.redisClients) return;
    await closeSocketIoRedisClients(this.redisClients);
    this.logger.log('Socket.IO Redis pub/sub 连接已关闭');
  }
}
