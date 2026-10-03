import { Socket } from 'socket.io';
import { UserBasePayload } from '@/modules/users/users.service';

export interface AuthSocket extends Socket {
  // 使用脱敏后的 UserBasePayload（不含 password / deletedAt），
  // 与 findOneOrThrow 返回类型一致，避免把密码哈希挂到 socket 内存中。
  user?: UserBasePayload;
  handshake: Socket['handshake'] & {
    auth: { token?: string };
  };
}
