import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// 房间名长度上限：避免恶意长字符串作为 room key 占用内存。
const ROOM_MAX_LENGTH = 100;
// 单条消息长度上限：广播/私信/房间消息均适用，防止超大 payload 放大为 N 倍流量。
const MESSAGE_MAX_LENGTH = 2000;

export class JoinRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROOM_MAX_LENGTH)
  room!: string;
}

export class LeaveRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROOM_MAX_LENGTH)
  room!: string;
}

export class SendToRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ROOM_MAX_LENGTH)
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
