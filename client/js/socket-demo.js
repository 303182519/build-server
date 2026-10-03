/**
 * Socket.IO 实时通信 Demo（对应 src/modules/socket）
 *
 * 协议事实（以服务端 socket.gateway.ts / socket-event.types.ts 为准）：
 *   - namespace：/socket（全局前缀 /api 不作用于 WS Gateway）
 *   - 鉴权：handshake.auth.token 携带 JWT；失败时服务端 emit('exception', 401) 后断开
 *   - 客户端事件均返回 ack：join-room / leave-room / send-to-room /
 *     send-to-user / broadcast
 *   - 服务端事件：connected / user-joined / user-left / room-joined /
 *     room-left / room-user-joined / room-user-left / room-message /
 *     direct-message / broadcast-message / exception
 *
 * 直接双击打开 HTML（file://）也可运行：服务地址可配置，Gateway CORS 为 origin:'*'。
 * 登录接口走 HTTP，若浏览器因 CORS 拦截，请从 http://localhost:3001 打开本页。
 */

(() => {
  'use strict';

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  let accessToken = null;
  let socket = null;

  // ─── DOM 引用 ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const serverBaseInput = $('server-base');
  const emailInput = $('email');
  const passwordInput = $('password');
  const loginBtn = $('login-btn');
  const authState = $('auth-state');

  const connectBtn = $('connect-btn');
  const disconnectBtn = $('disconnect-btn');
  const connState = $('conn-state');
  const socketIdEl = $('socket-id');
  const myUserIdEl = $('my-user-id');
  const myUsernameEl = $('my-username');

  const roomNameInput = $('room-name');
  const roomMessageInput = $('room-message');
  const joinRoomBtn = $('join-room-btn');
  const leaveRoomBtn = $('leave-room-btn');
  const sendRoomBtn = $('send-room-btn');

  const targetUserIdInput = $('target-user-id');
  const directMessageInput = $('direct-message');
  const sendDirectBtn = $('send-direct-btn');

  const broadcastMessageInput = $('broadcast-message');
  const broadcastBtn = $('broadcast-btn');

  const eventLog = $('event-log');
  const clearLogBtn = $('clear-log-btn');

  // ─── 工具函数 ──────────────────────────────────────────────────────────────

  function getServerBase() {
    return serverBaseInput.value.trim().replace(/\/+$/, '');
  }

  function log(type, title, detail) {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    const ts = new Date().toLocaleTimeString();
    let text = `[${ts}] ${title}`;
    if (detail !== undefined) {
      let rendered;
      try {
        rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch {
        rendered = String(detail);
      }
      text += ` ${rendered}`;
    }
    // textContent 赋值，避免消息内容注入 HTML
    line.textContent = text;
    eventLog.appendChild(line);
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  function setConnStatus(status) {
    connState.textContent =
      status === 'connected'
        ? '已连接'
        : status === 'connecting'
          ? '连接中…'
          : '未连接';
    connState.className = `badge ${status}`;

    const connected = status === 'connected';
    const connectedOrConnecting = connected || status === 'connecting';
    connectBtn.disabled = !(accessToken && !connectedOrConnecting);
    disconnectBtn.disabled = !connectedOrConnecting;
    [joinRoomBtn, leaveRoomBtn, sendRoomBtn, sendDirectBtn, broadcastBtn].forEach(
      (btn) => {
        btn.disabled = !connected;
      },
    );
    if (!connected) {
      socketIdEl.textContent = '-';
    }
  }

  /**
   * 统一的「发送事件并等待 ack」封装：
   * socket.timeout(10s).emitWithAck 在 socket.io-client >=4.5 可用（CDN 为 4.8.4）。
   * - 业务失败：ack 体 { success:false,status,message,code }
   * - 网络/超时：抛错（如断线、10 秒无响应）
   */
  async function emitWithAck(eventName, payload) {
    if (!socket || !socket.connected) {
      throw new Error('socket 未连接');
    }
    const ack = await socket.timeout(10000).emitWithAck(eventName, payload);
    if (!ack || ack.success !== true) {
      const err = new Error(ack?.message || '服务端返回失败');
      err.ack = ack;
      throw err;
    }
    return ack;
  }

  async function apiFetch(path, options = {}) {
    const resp = await fetch(`${getServerBase()}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = body.message || body.error || `HTTP ${resp.status}`;
      throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
    }
    // 兼容统一响应信封 { data: {...} } 与裸对象两种返回
    return body.data ?? body;
  }

  // ─── 登录 ──────────────────────────────────────────────────────────────────

  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    authState.textContent = '登录中…';
    authState.style.color = '#57606a';
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: emailInput.value.trim(),
          password: passwordInput.value,
        }),
      });
      accessToken = data.accessToken;
      authState.textContent = '已登录，可以连接 Socket';
      authState.style.color = '#1a7f37';
      connectBtn.disabled = Boolean(socket && (socket.connected || socket.active));
      log('info', '登录成功', { userId: data.user?.id ?? data.userId });
    } catch (err) {
      accessToken = null;
      authState.textContent = `登录失败：${err.message}`;
      authState.style.color = '#cf222e';
    } finally {
      loginBtn.disabled = false;
    }
  });

  // ─── Socket 生命周期 ───────────────────────────────────────────────────────

  function registerSocketListeners() {
    socket.on('connect', () => {
      setConnStatus('connected');
      socketIdEl.textContent = socket.id;
      log('success', 'connect', { socketId: socket.id });
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      setConnStatus('connecting');
      log('info', 'reconnect_attempt', { attempt });
    });

    socket.io.on('reconnect', (attempt) => {
      log('success', 'reconnected', { attempt });
    });

    socket.io.on('reconnect_error', (error) => {
      log('error', 'reconnect_error', { message: error.message });
    });

    socket.on('connect_error', (error) => {
      // 鉴权失败 / 网络不可达 / 服务端未启动都会到这里；socket.io 会自动重试
      setConnStatus('connecting');
      log('error', 'connect_error', {
        message: error.message,
        description: error.description,
      });
    });

    socket.on('disconnect', (reason) => {
      setConnStatus('disconnected');
      // 'io server disconnect'：服务端主动断开（如鉴权失败 5 秒宽限期到期、
      // 并发连接数超限），socket.io 不会自动重连，需手动点「连接」
      log(
        reason === 'io server disconnect' ? 'error' : 'info',
        'disconnect',
        { reason },
      );
    });

    // ── 服务端业务事件（名称与 payload 严格对应 socket-event.types.ts） ──
    socket.on('connected', (data) => {
      myUserIdEl.textContent = data.userId;
      myUsernameEl.textContent = data.username;
      log('success', 'connected', data);
    });

    socket.on('user-joined', (data) => log('info', 'user-joined', data));
    socket.on('user-left', (data) => log('info', 'user-left', data));

    socket.on('room-joined', (data) => log('success', 'room-joined', data));
    socket.on('room-left', (data) => log('success', 'room-left', data));
    socket.on('room-user-joined', (data) =>
      log('info', 'room-user-joined', data),
    );
    socket.on('room-user-left', (data) =>
      log('info', 'room-user-left', data),
    );

    socket.on('room-message', (data) => log('event', 'room-message', data));
    socket.on('direct-message', (data) =>
      log('event', 'direct-message', data),
    );
    socket.on('broadcast-message', (data) =>
      log('event', 'broadcast-message', data),
    );

    // 统一错误通道：连接期鉴权失败 / 无 ack 的消息期异常均经此事件下发
    socket.on('exception', (data) => {
      log('error', 'exception', data);
      if (data?.status === 401) {
        log(
          'error',
          '鉴权失败（401）',
          'token 缺失/过期或用户不存在，请重新登录后再连接',
        );
      }
    });
  }

  connectBtn.addEventListener('click', () => {
    if (!accessToken) {
      log('error', '未登录，请先登录获取 JWT');
      return;
    }
    const base = getServerBase();
    if (!base) {
      log('error', '请填写服务地址');
      return;
    }
    if (typeof io === 'undefined') {
      log('error', 'socket.io CDN 未加载，请检查网络后刷新页面');
      return;
    }

    if (socket) {
      // 复用已有实例（含被服务端主动断开的场景）：刷新 token 后手动重连
      socket.auth = { token: accessToken };
      socket.connect();
    } else {
      socket = io(`${base}/socket`, {
        auth: { token: accessToken },
        transports: ['websocket', 'polling'],
      });
      registerSocketListeners();
    }
    setConnStatus('connecting');
  });

  disconnectBtn.addEventListener('click', () => {
    if (socket) {
      // 客户端主动断开：不会自动重连
      socket.disconnect();
    }
  });

  // ─── 房间 ──────────────────────────────────────────────────────────────────

  joinRoomBtn.addEventListener('click', async () => {
    const room = roomNameInput.value.trim();
    if (!room) return log('error', '请填写 room');
    try {
      await emitWithAck('join-room', { room });
      log('success', 'ack join-room', { room });
    } catch (err) {
      log('error', 'join-room 失败', err.ack || err.message);
    }
  });

  leaveRoomBtn.addEventListener('click', async () => {
    const room = roomNameInput.value.trim();
    if (!room) return log('error', '请填写 room');
    try {
      await emitWithAck('leave-room', { room });
      log('success', 'ack leave-room', { room });
    } catch (err) {
      log('error', 'leave-room 失败', err.ack || err.message);
    }
  });

  sendRoomBtn.addEventListener('click', async () => {
    const room = roomNameInput.value.trim();
    const message = roomMessageInput.value;
    if (!room) return log('error', '请填写 room');
    if (!message.trim()) return log('error', '消息内容不能为空');
    try {
      await emitWithAck('send-to-room', { room, message });
      log('success', 'ack send-to-room', { room });
      roomMessageInput.value = '';
    } catch (err) {
      log('error', 'send-to-room 失败', err.ack || err.message);
    }
  });

  // ─── 私信 ──────────────────────────────────────────────────────────────────

  sendDirectBtn.addEventListener('click', async () => {
    const targetUserId = targetUserIdInput.value.trim();
    const message = directMessageInput.value;
    if (!targetUserId) return log('error', '请填写目标 userId');
    if (!message.trim()) return log('error', '消息内容不能为空');
    try {
      await emitWithAck('send-to-user', { targetUserId, message });
      log('success', 'ack send-to-user', { targetUserId });
      directMessageInput.value = '';
    } catch (err) {
      log('error', 'send-to-user 失败', err.ack || err.message);
    }
  });

  // ─── 广播 ──────────────────────────────────────────────────────────────────

  broadcastBtn.addEventListener('click', async () => {
    const message = broadcastMessageInput.value;
    if (!message.trim()) return log('error', '消息内容不能为空');
    try {
      await emitWithAck('broadcast', { message });
      log('success', 'ack broadcast');
      broadcastMessageInput.value = '';
    } catch (err) {
      log('error', 'broadcast 失败', err.ack || err.message);
    }
  });

  // ─── 其他 ──────────────────────────────────────────────────────────────────

  clearLogBtn.addEventListener('click', () => {
    eventLog.textContent = '';
  });

  // 输入框回车触发对应按钮
  const enterTriggers = [
    [passwordInput, loginBtn],
    [roomNameInput, joinRoomBtn],
    [roomMessageInput, sendRoomBtn],
    [directMessageInput, sendDirectBtn],
    [broadcastMessageInput, broadcastBtn],
  ];
  enterTriggers.forEach(([input, btn]) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !btn.disabled) btn.click();
    });
  });

  // 关闭页面前主动断开，让服务端立即清理本节点连接（否则依赖 transport 超时）
  window.addEventListener('beforeunload', () => {
    if (socket) socket.disconnect();
  });

  // 初始化按钮状态
  setConnStatus('disconnected');
})();
