import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

// 房间名长度上限：避免恶意长字符串作为 room key 占用内存。
const ROOM_MAX_LENGTH = 100;
// 单条消息长度上限：广播/私信/房间消息均适用，防止超大 payload 放大为 N 倍流量。
const MESSAGE_MAX_LENGTH = 2000;

/**
 * 服务端系统房间保留前缀，客户端禁止加入 / 离开 / 向其发送消息。
 *
 * 多实例下私信投递依赖 Socket.IO 房间（经 Redis adapter 跨节点路由），
 * 用户房间名为 `${SYSTEM_ROOM_PREFIX}user:${userId}`，由服务端在鉴权通过后
 * 自动加入。房间只能经由服务端 join 处理器加入，因此在入参校验层封死后，
 * 客户端无法自行加入他人房间窃听 direct-message，也无法向系统房间伪造消息。
 */
export const SYSTEM_ROOM_PREFIX = 'system:';
// 负向先行断言：拒绝以 system: 开头的房间名（空串由 @IsNotEmpty 拦截）。
// class-validator 0.15 无 NotMatches，使用 Matches + 负向断言等价表达。
const NON_SYSTEM_ROOM_PATTERN = /^(?!system:)/;

export class JoinRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROOM_MAX_LENGTH)
  @Matches(NON_SYSTEM_ROOM_PATTERN, {
    message: 'room 不能使用系统保留前缀 system:',
  })
  room!: string;
}

export class LeaveRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROOM_MAX_LENGTH)
  @Matches(NON_SYSTEM_ROOM_PATTERN, {
    message: 'room 不能使用系统保留前缀 system:',
  })
  room!: string;
}

export class SendToRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROOM_MAX_LENGTH)
  @Matches(NON_SYSTEM_ROOM_PATTERN, {
    message: 'room 不能使用系统保留前缀 system:',
  })
  room!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  message!: string;
}

export class SendToUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  targetUserId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  message!: string;
}

export class BroadcastDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  message!: string;
}
