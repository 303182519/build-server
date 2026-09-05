/**
 * 异步导出 + SSE 进度监听示例
 *
 * 流程：
 *  1. POST /api/auth/login          → 拿 accessToken
 *  2. POST /api/background-tasks/export-report → 拿到 jobId
 *  3. GET  /api/jobs/:id/events     → fetch + ReadableStream 手动解析 SSE
 *
 * 为什么不用原生 EventSource？
 *  原生 EventSource 不支持自定义请求头，而本项目的 SSE 接口需要 Authorization。
 *  因此改用 fetch 读取 ReadableStream，手动按 SSE 文本协议解析事件。
 */

(() => {
  'use strict';

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  let accessToken = null;
  let currentJobId = null;
  let abortController = null; // 用于取消正在进行的 SSE fetch

  // ─── DOM 引用 ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const emailInput = $('email');
  const passwordInput = $('password');
  const loginBtn = $('login-btn');
  const authState = $('auth-state');

  const titleInput = $('title');
  const stepsInput = $('steps');
  const stepDelayMsInput = $('step-delay-ms');
  const delayMsInput = $('delay-ms');
  const exportBtn = $('export-btn');
  const exportHint = $('export-hint');

  const jobIdInput = $('job-id-input');
  const subscribeBtn = $('subscribe-btn');
  const subscribeHint = $('subscribe-hint');

  const jobIdEl = $('job-id');
  const jobStatusEl = $('job-status');
  const jobProgressText = $('job-progress-text');
  const progressBar = $('progress-bar');
  const jobResult = $('job-result');
  const sseLog = $('sse-log');

  // ─── 工具函数 ──────────────────────────────────────────────────────────────

  /** 追加一条 SSE 日志 */
  function appendLog(type, text) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] [${type}] ${text}`;
    sseLog.appendChild(line);
    sseLog.scrollTop = sseLog.scrollHeight;
  }

  /** 更新任务状态 UI */
  function updateJobUI(job) {
    jobIdEl.textContent = job.id || '-';
    jobStatusEl.textContent = job.status || '-';

    // 状态徽章样式
    jobStatusEl.className = 'badge';
    if (['active', 'queued'].includes(job.status)) {
      jobStatusEl.classList.add('active');
    } else if (job.status === 'completed') {
      jobStatusEl.classList.add('completed');
    } else if (['failed', 'cancelled'].includes(job.status)) {
      jobStatusEl.classList.add('failed');
    } else if (job.status === 'delayed') {
      jobStatusEl.classList.add('active');
    }

    // 进度条
    const pct = Math.min(100, Math.max(0, job.progress ?? 0));
    progressBar.style.width = pct + '%';
    jobProgressText.textContent = pct + '%';

    // 结果 / 错误信息
    jobResult.innerHTML = '';
    if (job.status === 'completed' && job.result != null) {
      const div = document.createElement('div');
      div.className = 'result';
      div.textContent = '✅ 结果：' + JSON.stringify(job.result, null, 2);
      jobResult.appendChild(div);
    }
    if (job.status === 'failed' && job.errorMessage) {
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = '❌ 错误：' + job.errorMessage;
      jobResult.appendChild(div);
    }
    if (job.status === 'cancelled') {
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = '⛔ 任务已取消';
      jobResult.appendChild(div);
    }
  }

  /**
   * 手动解析 SSE 文本流。
   *
   * SSE 协议：
   *   event: job.updated
   *   id: 3
   *   data: {"id":"...","status":"active",...}
   *   \n          ← 空行分隔事件
   *
   * 累积 buffer，按双换行切分事件块，再解析每个字段。
   */
  function createSseParser(onEvent) {
    let buffer = '';

    return {
      /** 喂入一段文本 */
      feed(chunk) {
        buffer += chunk;
        // 按双换行（\n\n）切分完整事件块
        const parts = buffer.split('\n\n');
        // 最后一段可能不完整，留到下次
        buffer = parts.pop() ?? '';

        for (const block of parts) {
          if (!block.trim()) continue;
          const fields = {};
          for (const line of block.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx <= 0) continue;
            const key = line.slice(0, colonIdx).trim();
            const val = line.slice(colonIdx + 1).trim();
            fields[key] = val;
          }
          if (fields.event || fields.data) {
            onEvent(fields);
          }
        }
      },

      /** 重置 buffer */
      reset() {
        buffer = '';
      },
    };
  }

  // ─── 1. 登录 ──────────────────────────────────────────────────────────────

  loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      authState.textContent = '请填写 email 和 password';
      return;
    }

    loginBtn.disabled = true;
    authState.textContent = '登录中…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const json = await res.json();

      if (json.code === 200 && json.data?.accessToken) {
        accessToken = json.data.accessToken;
        authState.textContent = '✅ 已登录（token 已获取）';
        authState.style.color = '#1a7f37';
        appendLog('AUTH', '登录成功，accessToken 已获取');
      } else {
        authState.textContent = '❌ 登录失败：' + (json.message || res.statusText);
        authState.style.color = '#cf222e';
      }
    } catch (err) {
      authState.textContent = '❌ 请求异常：' + err.message;
      authState.style.color = '#cf222e';
    } finally {
      loginBtn.disabled = false;
    }
  });

  // ─── 2. 提交导出任务 + 自动订阅 SSE ──────────────────────────────────────

  exportBtn.addEventListener('click', async () => {
    if (!accessToken) {
      exportHint.textContent = '请先登录';
      return;
    }

    exportBtn.disabled = true;
    exportHint.textContent = '提交中…';
    jobResult.innerHTML = '';

    try {
      const body = {
        title: titleInput.value.trim() || 'monthly-report',
        steps: parseInt(stepsInput.value, 10) || 5,
        stepDelayMs: parseInt(stepDelayMsInput.value, 10) || 500,
        delayMs: parseInt(delayMsInput.value, 10) || 0,
      };

      const res = await fetch('/api/background-tasks/export-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const json = await res.json();

      if (json.code === 200 && json.data?.id) {
        const job = json.data;
        currentJobId = job.id;
        jobIdInput.value = currentJobId;
        updateJobUI(job);
        exportHint.textContent = `✅ 已提交，jobId=${currentJobId}`;
        appendLog('SUBMIT', `任务已提交 jobId=${currentJobId} status=${job.status}`);
        // 自动开始监听 SSE
        startSse(currentJobId);
      } else {
        exportHint.textContent = '❌ 提交失败：' + (json.message || res.statusText);
      }
    } catch (err) {
      exportHint.textContent = '❌ 请求异常：' + err.message;
    } finally {
      exportBtn.disabled = false;
    }
  });

  // ─── 3. 手动订阅已有任务 SSE ─────────────────────────────────────────────

  subscribeBtn.addEventListener('click', () => {
    const id = jobIdInput.value.trim();
    if (!id) {
      subscribeHint.textContent = '请填写 jobId';
      return;
    }
    if (!accessToken) {
      subscribeHint.textContent = '请先登录';
      return;
    }
    currentJobId = id;
    subscribeHint.textContent = `正在订阅 ${id}…`;
    startSse(id);
  });

  // ─── SSE 订阅核心逻辑 ────────────────────────────────────────────────────

  function startSse(jobId) {
    // 取消上一次订阅
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    appendLog('SSE', `开始连接 GET /api/jobs/${jobId}/events`);

    const parser = createSseParser((fields) => {
      const eventName = fields.event || 'message';
      let data;
      try {
        data = JSON.parse(fields.data || '{}');
      } catch {
        data = fields.data;
      }

      appendLog(eventName, JSON.stringify(data));

      // 更新 UI（snapshot / updated / completed / failed / cancelled 都携带完整 job 视图）
      if (data && typeof data === 'object' && data.id) {
        updateJobUI(data);
      }

      // 终态时提示
      if (['job.completed', 'job.failed', 'job.cancelled'].includes(eventName)) {
        appendLog('SSE', '任务已进入终态，连接即将关闭');
        subscribeHint.textContent = `任务 ${jobId} 已结束（${eventName}）`;
      }
    });

    fetch(`/api/jobs/${jobId}/events`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'text/event-stream',
      },
      credentials: 'include',
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          appendLog('SSE', `连接失败 HTTP ${response.status}: ${text}`);
          subscribeHint.textContent = `SSE 连接失败：HTTP ${response.status}`;
          return;
        }

        subscribeHint.textContent = `✅ SSE 已连接，监听 ${jobId}`;
        appendLog('SSE', '连接已建立，等待事件…');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            appendLog('SSE', '流已结束');
            break;
          }
          const text = decoder.decode(value, { stream: true });
          parser.feed(text);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') {
          appendLog('SSE', '连接已主动取消');
        } else {
          appendLog('SSE', '连接异常：' + err.message);
          subscribeHint.textContent = `SSE 异常：${err.message}`;
        }
      });
  }
})();
