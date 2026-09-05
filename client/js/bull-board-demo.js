/**
 * Bull Board 任务监控面板 Demo
 *
 * 流程：
 *  1. POST /api/auth/login → 拿 accessToken
 *  2. 解码 JWT 查看 payload（确认 specialRoles 字段）
 *  3. 新标签页打开 /admin/queues?token=xxx 访问面板
 */

(() => {
  'use strict';

  // ─── 状态 ──────────────────────────────────────────────────────────────────
  let accessToken = null;
  let userPayload = null;

  // ─── DOM 引用 ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const emailInput = $('email');
  const passwordInput = $('password');
  const loginBtn = $('login-btn');
  const authState = $('auth-state');

  const userNameEl = $('user-name');
  const userRolesEl = $('user-roles');
  const tokenExpiresEl = $('token-expires');
  const jwtPayloadEl = $('jwt-payload');

  const boardLink = $('board-link');
  const boardPathEl = $('board-path');
  const boardAuthTypeEl = $('board-auth-type');
  const boardReadonlyEl = $('board-readonly');
  const copyLinkBtn = $('copy-link-btn');
  const copyHint = $('copy-hint');
  const roleWarn = $('role-warn');

  // ─── 工具函数 ──────────────────────────────────────────────────────────────

  /**
   * 解码 JWT payload（不校验签名，仅用于展示）。
   * JWT 格式：header.payload.signature
   */
  function decodeJwtPayload(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = parts[1];
      // Base64URL → Base64 → UTF-8
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join(''),
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /** 构建面板完整 URL（带 token） */
  function buildBoardUrl() {
    if (!accessToken) return '#';
    const path = boardPathEl.textContent || '/admin/queues';
    const url = new URL(path, window.location.origin);
    url.searchParams.set('token', accessToken);
    return url.toString();
  }

  /** 更新面板链接状态 */
  function updateBoardLink() {
    if (!accessToken) {
      boardLink.classList.add('disabled');
      boardLink.href = '#';
      boardLink.textContent = '打开任务监控面板';
      return;
    }

    const url = buildBoardUrl();
    boardLink.classList.remove('disabled');
    boardLink.href = url;
    boardLink.textContent = '打开任务监控面板 ↗';
  }

  /** 检查 specialRoles 是否满足面板访问要求 */
  function checkRoleAccess(payload) {
    const role = payload.specialRoles || payload['specialRoles'];
    const allowed = role === 'super_admin' || role === 'developer';

    if (!role) {
      roleWarn.style.display = 'block';
      roleWarn.innerHTML =
        '<strong>⚠️ 无法访问面板：</strong>JWT payload 中不包含 <code>specialRoles</code> 字段。' +
        '需要在签发 access token 时写入该字段，否则面板会返回 403。';
    } else if (!allowed) {
      roleWarn.style.display = 'block';
      roleWarn.innerHTML =
        `<strong>⚠️ 无法访问面板：</strong>当前 specialRoles = <code>${role}</code>，` +
        '面板要求 <code>super_admin</code> 或 <code>developer</code>。';
    } else {
      roleWarn.style.display = 'block';
      roleWarn.innerHTML =
        `<strong>✅ 可以访问面板：</strong>specialRoles = <code>${role}</code>，符合访问要求。`;
      roleWarn.style.background = '#dafbe1';
      roleWarn.style.borderColor = '#4ac26b';
    }
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
        const user = json.data.user;
        const expiresAt = json.data.expiresAt;

        // 显示用户信息
        userNameEl.textContent = user?.username || '-';
        userRolesEl.textContent = user?.specialRoles || '(无)';

        if (expiresAt) {
          const d = new Date(typeof expiresAt === 'number' && expiresAt < 1e12 ? expiresAt * 1000 : expiresAt);
          tokenExpiresEl.textContent = d.toLocaleString();
        }

        // 解码 JWT payload
        userPayload = decodeJwtPayload(accessToken);
        if (userPayload) {
          jwtPayloadEl.textContent = JSON.stringify(userPayload, null, 2);
          checkRoleAccess(userPayload);
        } else {
          jwtPayloadEl.textContent = '(无法解码 JWT payload)';
        }

        authState.textContent = '✅ 已登录（token 已获取）';
        authState.style.color = '#1a7f37';

        // 启用面板链接
        updateBoardLink();
        copyLinkBtn.disabled = false;
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

  // ─── 2. 复制面板链接 ──────────────────────────────────────────────────────

  copyLinkBtn.addEventListener('click', async () => {
    if (!accessToken) return;

    const url = buildBoardUrl();
    try {
      await navigator.clipboard.writeText(url);
      copyHint.textContent = '✅ 已复制到剪贴板';
    } catch {
      // 降级：选中链接文本
      copyHint.textContent = '复制失败，请手动复制链接：' + url;
    }
  });
})();
