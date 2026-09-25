/**
 * Agent 人工审批工作流示例
 *
 * 流程：
 *  1. POST /api/auth/login          → 拿 accessToken
 *  2. POST /api/agent/runs          → 拿 runId / threadId
 *  3. GET  /api/agent/runs/:id/events → fetch + ReadableStream 手动解析 SSE
 *  4. POST /api/agent/runs/:id/decide → 批准 / 拒绝
 *
 * 为什么不用原生 EventSource？
 *  原生 EventSource 不支持自定义请求头，而本项目的 SSE 接口需要 Authorization。
 *  因此改用 fetch 读取 ReadableStream，手动按 SSE 文本协议解析事件。
 */

(() => {
  'use strict';

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  let accessToken = null;
  let currentRunId = null;
  let abortController = null;
  // 本次连接是否已收到终态事件：用于区分「运行正常结束后服务端关流」与「异常断开」
  let terminalReceived = false;

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

  function updateRunUI(run) {
    runIdEl.textContent = run.id || '-';
    threadIdEl.textContent = run.threadId || '-';
    runPromptEl.textContent = run.prompt || '-';
    setStatusBadge(run.status);

    if (run.error) {
      showError(`运行失败：${run.error}`);
      decideHint.textContent = '运行失败';
    } else if (run.result && run.result.postId) {
      showResult(`副作用执行成功，已创建文章草稿 postId=${run.result.postId}`);
      decideHint.textContent = '已完成，文章草稿已创建';
    } else if (run.status === 'REJECTED') {
      showResult(`已拒绝${run.reason ? `：${run.reason}` : ''}`);
      decideHint.textContent = '已拒绝';
    } else {
      clearFeedback();
    }

    // 草稿就绪且仍待审批 → 显示审批卡片
    if (run.payload && run.status === 'PENDING') {
      updateDraftUI(run.payload);
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    } else {
      // 已审批 / 已执行 → 锁定按钮
      if (run.status !== 'PENDING') {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
      }
    }
  }

  // ─── SSE 解析 ─────────────────────────────────────────────────────────────

  /**
   * 手动解析 SSE 文本流。
   * 每帧格式：
   *   event: xxx
   *   id: 123
   *   data: {...}
   *
   * 以空行分隔。
   */
  async function consumeSseStream(runId) {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    const url = `/api/agent/runs/${runId}/events`;
    appendLog('SSE', `连接 ${url}`);
    terminalReceived = false;

    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
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

        // 按空行切分 SSE 帧
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
          : '连接已关闭（服务端在终态前断开，可重新订阅恢复现场）',
      );
      if (terminalReceived) subscribeHint.textContent = '运行已结束';
    } catch (err) {
      if (err.name === 'AbortError') {
        appendLog('SSE', '已取消订阅');
      } else {
        appendLog('SSE', `连接异常：${err.message}`);
        subscribeHint.textContent = '连接异常，请重试';
      }
    }
  }

  function handleSseFrame(rawFrame) {
    let event = 'message';
    let data = null;

    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) {
        // 心跳注释行，忽略
        continue;
      }
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          data = line.slice(6);
        }
      }
      // id 行目前未在客户端使用，可忽略
    }

    appendLog(event, typeof data === 'string' ? data : JSON.stringify(data));

    if (data && typeof data === 'object') {
      updateRunUI(data);
      // 与后端终态口径保持一致：REJECTED / 已产出 result / 有 error
      if (
        data.status === 'REJECTED' ||
        (data.result && data.result.postId) ||
        data.error
      ) {
        terminalReceived = true;
      }
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
    // 项目统一响应 envelope：{ code, data, message }
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
      updateRunUI(run);
      startHint.textContent = `已发起 runId=${run.id}，等待 Qwen 草稿…`;
      consumeSseStream(run.id);
    } catch (err) {
      startHint.textContent = `发起失败：${err.message}`;
    } finally {
      startBtn.disabled = false;
    }
  });

  subscribeBtn.addEventListener('click', () => {
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
    consumeSseStream(id);
  });

  async function decide(approve) {
    if (!currentRunId) {
      decideHint.textContent = '没有可审批的运行';
      return;
    }
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    decideHint.textContent = approve ? '批准中…' : '拒绝中…';
    try {
      const run = await apiFetch(`/agent/runs/${currentRunId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          approve,
          reason: reasonInput.value || undefined,
        }),
      });
      updateRunUI(run);
      // /decide 在服务端会 await 完整个图执行才返回，因此这里可能已是终态，
      // 不能无条件覆盖 SSE 已更新的终态提示
      if (!approve) {
        decideHint.textContent = '已拒绝';
      } else if (run.result && run.result.postId) {
        decideHint.textContent = '已完成，文章草稿已创建';
      } else if (run.error) {
        decideHint.textContent = '运行失败';
      } else {
        decideHint.textContent = '已批准，正在执行副作用…';
      }
    } catch (err) {
      decideHint.textContent = `操作失败：${err.message}`;
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  }

  approveBtn.addEventListener('click', () => decide(true));
  rejectBtn.addEventListener('click', () => decide(false));
})();
