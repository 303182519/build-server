/**
 * Agent 人工审批工作流示例（适配 v2 AgentEvent 协议）
 *
 * 协议：SSE 每帧 event 对应 AgentEvent 信封，data 字段在 data.payload 里。
 * 终态事件（run.completed / run.cancelled / error）到达后服务端主动关流。
 *
 * 为什么不用原生 EventSource？
 *   原生 EventSource 不支持自定义 Authorization header；
 *   改用 fetch + ReadableStream 手动解析 SSE，并在 header 中携带 Last-Event-ID 实现断线续传。
 */

(() => {
  'use strict';

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  let accessToken = null;
  let currentRunId = null;
  let abortController = null;
  let lastEventId = null; // SSE 断线续传游标
  let terminalReceived = false; // 是否已收到终态事件
  let reconnectAttempts = 0; // 连续无进展重连次数（收到任意事件即清零）
  const MAX_RECONNECT_ATTEMPTS = 5;

  // ─── DOM 引用 ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const emailInput = $('email');
  const passwordInput = $('password');
  const loginBtn = $('login-btn');
  const authState = $('auth-state');

  const promptInput = $('prompt');
  const startBtn = $('start-btn');
  const startHint = $('start-hint');

  const runIdInput = $('run-id-input');
  const subscribeBtn = $('subscribe-btn');
  const subscribeHint = $('subscribe-hint');

  const runIdEl = $('run-id');
  const threadIdEl = $('thread-id');
  const runStatusEl = $('run-status');
  const runPromptEl = $('run-prompt');
  const runErrorEl = $('run-error');
  const runResultEl = $('run-result');

  const cancelBtn = $('cancel-btn');
  const cancelHint = $('cancel-hint');

  const streamSection = $('stream-section');
  const streamOutput = $('stream-output');

  const draftSection = $('draft-section');
  const draftTitle = $('draft-title');
  const draftSlug = $('draft-slug');
  const draftContent = $('draft-content');
  const draftTags = $('draft-tags');
  const reasonInput = $('reason');
  const approveBtn = $('approve-btn');
  const rejectBtn = $('reject-btn');
  const decideHint = $('decide-hint');

  const sseLog = $('sse-log');

  // ─── 工具函数 ──────────────────────────────────────────────────────────────

  function appendLog(type, text) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] [${type}] ${text}`;
    sseLog.appendChild(line);
    sseLog.scrollTop = sseLog.scrollHeight;
  }

  function setStatusBadge(status) {
    runStatusEl.textContent = status;
    runStatusEl.className = 'badge';
    if (status === 'PENDING') runStatusEl.classList.add('pending');
    else if (status === 'APPROVED') runStatusEl.classList.add('approved');
    else if (status === 'REJECTED') runStatusEl.classList.add('rejected');
    else if (status === 'CANCELLED') runStatusEl.classList.add('cancelled');
  }

  function showError(msg) {
    runErrorEl.textContent = msg;
    runErrorEl.classList.remove('hidden');
    runResultEl.classList.add('hidden');
  }

  function showResult(msg) {
    runResultEl.textContent = msg;
    runResultEl.classList.remove('hidden');
    runErrorEl.classList.add('hidden');
  }

  function clearFeedback() {
    runErrorEl.classList.add('hidden');
    runResultEl.classList.add('hidden');
  }

  function resetStreamUI() {
    streamOutput.textContent = '';
    streamSection.classList.add('hidden');
  }

  function appendStreamDelta(content) {
    streamSection.classList.remove('hidden');
    streamOutput.textContent += content;
    streamOutput.scrollTop = streamOutput.scrollHeight;
  }

  function updateDraftUI(draft) {
    if (!draft) {
      draftSection.classList.add('hidden');
      return;
    }
    draftTitle.textContent = draft.title || '';
    draftSlug.textContent = draft.slug ? `slug: ${draft.slug}` : '';
    draftContent.textContent = draft.content || '';
    draftTags.textContent = Array.isArray(draft.tags)
      ? `tags: ${draft.tags.join(', ')}`
      : '';
    draftSection.classList.remove('hidden');
  }

  /**
   * 根据 /api/agent/runs/:id 快照刷新运行状态区。
   * 订阅/发起前先调这个，让页面不依赖 SSE 就能有初始状态。
   */
  function updateRunUIFromSnapshot(run) {
    runIdEl.textContent = run.id || '-';
    threadIdEl.textContent = run.threadId || '-';
    runPromptEl.textContent = run.prompt || '-';
    setStatusBadge(run.status);

    if (run.status === 'CANCELLED') {
      showResult(`已取消${run.reason ? `：${run.reason}` : ''}`);
    } else if (run.status === 'REJECTED') {
      showResult(`已拒绝${run.reason ? `：${run.reason}` : ''}`);
    } else if (run.error) {
      showError(`运行失败：${run.error}`);
    } else if (run.result && run.result.postId) {
      showResult(`副作用执行成功，已创建文章草稿 postId=${run.result.postId}`);
    } else {
      clearFeedback();
    }

    // 草稿就绪且仍待审批 → 显示审批卡片
    if (run.payload && run.status === 'PENDING') {
      updateDraftUI(run.payload);
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      cancelBtn.classList.remove('hidden');
    } else {
      draftSection.classList.add('hidden');
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      cancelBtn.classList.add('hidden');
    }

    // 只有 PENDING 且没终态才允许取消
    if (run.status === 'PENDING' && !run.error && !run.result) {
      cancelBtn.classList.remove('hidden');
    } else {
      cancelBtn.classList.add('hidden');
    }
  }

  // ─── SSE 解析 ─────────────────────────────────────────────────────────────

  /**
   * 手动解析 SSE 文本流，提取 id / event / data。
   * 每帧以空行分隔；data 行可能有多行，需拼接。
   */
  async function consumeSseStream(runId) {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    const url = `/api/agent/runs/${runId}/events`;
    appendLog('SSE', `连接 ${url}${lastEventId ? ` (afterId=${lastEventId})` : ''}`);
    terminalReceived = false;

    try {
      const headers = { Authorization: `Bearer ${accessToken}` };
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;

      const resp = await fetch(url, {
        headers,
        signal: abortController.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        appendLog('SSE', `HTTP ${resp.status}: ${text}`);
        subscribeHint.textContent = `订阅失败：HTTP ${resp.status}`;
        return;
      }

      subscribeHint.textContent = '已连接，等待事件…';
      appendLog('SSE', '连接已建立');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          handleSseFrame(rawFrame);
        }
      }

      appendLog(
        'SSE',
        terminalReceived
          ? '运行已结束，SSE 连接正常关闭'
          : '连接已关闭（服务端在终态前断开，将自动重连）',
      );

      // 非终态断开 → 自动重连（等价于浏览器 EventSource 的自带行为）
      if (!terminalReceived) scheduleReconnect(runId);
      else subscribeHint.textContent = '运行已结束';
    } catch (err) {
      if (err.name === 'AbortError') {
        appendLog('SSE', '已取消订阅');
      } else {
        appendLog('SSE', `连接异常：${err.message}`);
        scheduleReconnect(runId);
      }
    }
  }

  /**
   * 自动重连：带次数上限，防止「订阅已终态且 stream 已过期的旧 run」时
   * 服务端立即关流导致每秒空转重连。
   */
  function scheduleReconnect(runId) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      subscribeHint.textContent = '连接已断开，重连次数过多，请手动重新订阅';
      appendLog('SSE', '重连次数达到上限，停止重连');
      return;
    }
    reconnectAttempts++;
    subscribeHint.textContent = `连接断开，1s 后自动重连（第 ${reconnectAttempts} 次）…`;
    setTimeout(() => consumeSseStream(runId), 1000);
  }

  /**
   * 解析单帧 SSE 文本，触发对应事件处理。
   */
  function handleSseFrame(rawFrame) {
    let eventName = 'message';
    let dataLines = [];

    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) continue; // 心跳注释行
      if (line.startsWith('id: ')) {
        lastEventId = line.slice(4).trim();
      } else if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      }
    }

    const dataText = dataLines.join('\n');
    if (!dataText) return; // 纯心跳/注释帧

    let envelope;
    try {
      envelope = JSON.parse(dataText);
    } catch {
      appendLog(eventName, dataText);
      return;
    }

    // 收到有效事件说明连接有进展，重连计数清零
    reconnectAttempts = 0;

    appendLog(eventName, dataText);
    dispatchAgentEvent(eventName, envelope);
  }

  /**
   * 按 AgentEventType 分发处理。
   * envelope 结构：{ eventId, runId, type, timestamp, data, sequence }
   */
  function dispatchAgentEvent(eventName, envelope) {
    const payload = envelope?.data;
    const type = envelope?.type || eventName;

    switch (type) {
      case 'run.started': {
        threadIdEl.textContent = payload?.threadId || '-';
        runPromptEl.textContent = payload?.prompt || '-';
        setStatusBadge('PENDING');
        resetStreamUI();
        break;
      }

      case 'node.started':
      case 'node.completed': {
        // 仅打日志，无需 UI 变化
        break;
      }

      case 'message.delta': {
        if (payload?.content) appendStreamDelta(payload.content);
        break;
      }

      case 'message.completed': {
        // 流式输出已完成，可选在内容末尾加标记
        break;
      }

      case 'interrupt': {
        // 图挂起，显示草稿和审批按钮
        if (payload?.draft) {
          updateDraftUI(payload.draft);
          approveBtn.disabled = false;
          rejectBtn.disabled = false;
          cancelBtn.classList.remove('hidden');
          decideHint.textContent = '草稿已就绪，请审批';
        }
        break;
      }

      case 'tool.started': {
        decideHint.textContent = '正在执行副作用…';
        break;
      }

      case 'tool.completed': {
        if (payload?.error) {
          showError(`副作用失败：${payload.error}`);
        } else if (payload?.result?.postId) {
          showResult(`已创建文章草稿 postId=${payload.result.postId}`);
        }
        break;
      }

      case 'run.completed': {
        terminalReceived = true;
        const run = payload?.run;
        if (run) updateRunUIFromSnapshot(run);
        decideHint.textContent = '运行已结束';
        break;
      }

      case 'run.cancelled': {
        terminalReceived = true;
        const run = payload?.run;
        if (run) updateRunUIFromSnapshot(run);
        decideHint.textContent = '运行已取消';
        break;
      }

      case 'error': {
        terminalReceived = true;
        showError(`运行错误：${payload?.message || '未知错误'}`);
        decideHint.textContent = '运行失败';
        break;
      }

      default:
        break;
    }
  }

  // ─── API 调用 ─────────────────────────────────────────────────────────────

  async function apiFetch(path, options = {}) {
    const resp = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    });

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = body.message || body.error || `HTTP ${resp.status}`;
      throw new Error(Array.isArray(msg) ? msg.join('; ') : msg);
    }
    return body.data ?? body;
  }

  // ─── 事件绑定 ─────────────────────────────────────────────────────────────

  loginBtn.addEventListener('click', async () => {
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: emailInput.value,
          password: passwordInput.value,
        }),
      });
      accessToken = data.accessToken;
      authState.textContent = '已登录';
      authState.style.color = '#1a7f37';
    } catch (err) {
      authState.textContent = `登录失败：${err.message}`;
      authState.style.color = '#cf222e';
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!accessToken) {
      startHint.textContent = '请先登录';
      return;
    }
    startBtn.disabled = true;
    startHint.textContent = '发起中…';
    try {
      const run = await apiFetch('/agent/runs', {
        method: 'POST',
        body: JSON.stringify({ prompt: promptInput.value }),
      });
      currentRunId = run.id;
      runIdInput.value = run.id;
      lastEventId = null;
      reconnectAttempts = 0;
      updateRunUIFromSnapshot(run);
      startHint.textContent = `已发起 runId=${run.id}，等待流式输出…`;
      consumeSseStream(run.id);
    } catch (err) {
      startHint.textContent = `发起失败：${err.message}`;
    } finally {
      startBtn.disabled = false;
    }
  });

  subscribeBtn.addEventListener('click', async () => {
    if (!accessToken) {
      subscribeHint.textContent = '请先登录';
      return;
    }
    const id = runIdInput.value.trim();
    if (!id) {
      subscribeHint.textContent = '请输入 runId';
      return;
    }
    currentRunId = id;
    lastEventId = null;
    reconnectAttempts = 0;

    // 先拉快照渲染当前状态（避免 SSE 空窗期白屏）
    try {
      const run = await apiFetch(`/agent/runs/${id}`);
      updateRunUIFromSnapshot(run);
    } catch (err) {
      subscribeHint.textContent = `拉取快照失败：${err.message}`;
      return;
    }

    consumeSseStream(id);
  });

  async function decide(approve) {
    if (!currentRunId) {
      decideHint.textContent = '没有可审批的运行';
      return;
    }
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    cancelBtn.classList.add('hidden');
    decideHint.textContent = approve ? '批准中…' : '拒绝中…';
    try {
      const run = await apiFetch(`/agent/runs/${currentRunId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          approve,
          reason: reasonInput.value || undefined,
        }),
      });
      updateRunUIFromSnapshot(run);
      if (run.status === 'REJECTED') {
        decideHint.textContent = '已拒绝';
      } else if (run.result && run.result.postId) {
        decideHint.textContent = '已完成，文章草稿已创建';
      } else if (run.error) {
        decideHint.textContent = '运行失败';
      } else if (run.status === 'APPROVED') {
        decideHint.textContent = '已批准，正在执行副作用…';
      }
    } catch (err) {
      decideHint.textContent = `操作失败：${err.message}`;
      // 失败时恢复按钮状态（除非快照显示已不是 PENDING）
      if (runStatusEl.textContent === 'PENDING') {
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        cancelBtn.classList.remove('hidden');
      }
    }
  }

  approveBtn.addEventListener('click', () => decide(true));
  rejectBtn.addEventListener('click', () => decide(false));

  cancelBtn.addEventListener('click', async () => {
    if (!currentRunId) {
      cancelHint.textContent = '没有可取消的运行';
      return;
    }
    cancelBtn.disabled = true;
    cancelHint.textContent = '取消中…';
    try {
      const run = await apiFetch(`/agent/runs/${currentRunId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: reasonInput.value || undefined }),
      });
      updateRunUIFromSnapshot(run);
      cancelHint.textContent = '已取消';
      // 不主动断开 SSE：服务端会补发 run.cancelled 终态事件并自然关流
    } catch (err) {
      cancelHint.textContent = `取消失败：${err.message}`;
      cancelBtn.disabled = false;
    }
  });
})();
