export interface ServerToClientEvents {
  connected: (data: {
    message: string;
    userId: string;
    username: string;
  }) => void;
  'user-joined': (data: { userId: string; username: string }) => void;
  'user-left': (data: { userId: string; username: string }) => void;
  'room-joined': (data: { room: string }) => void;
  'room-left': (data: { room: string }) => void;
  'room-user-joined': (data: {
    room: string;
    userId: string;
    username: string;
  }) => void;
  'room-user-left': (data: {
    room: string;
    userId: string;
    username: string;
  }) => void;
  'room-message': (data: {
    room: string;
    message: string;
    senderId: string;
    senderUsername: string;
    timestamp: string;
  }) => void;
  'direct-message': (data: {
    message: string;
    senderId: string;
    senderUsername: string;

    timestamp: string;
  }) => void;
  'broadcast-message': (data: {
    message: string;
    senderId: string;
    senderUsername: string;
    timestamp: string;
  }) => void;
  error: (data: { message: string }) => void;
  exception: (data: { status: number; message: string; code?: string }) => void;
}

export interface ClientToServerEvents {
  'join-room': (data: { room: string }) => void;
  'leave-room': (data: { room: string }) => void;
  'send-to-room': (data: { room: string; message: string }) => void;
  'send-to-user': (data: { targetUserId: string; message: string }) => void;
  broadcast: (data: { message: string }) => void;
}

export interface AckResponse {
  success: boolean;
  message?: string;
  /**
   * 统一错误信封：emit 携带 ack 回调时，错误经 ack 返回并附带
   * status / code（与 exception 事件同构）；成功时仅 success: true。
   */
  status?: number;
  code?: string;
}
