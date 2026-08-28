export const REFRESH_TOKEN_KEY = 'refreshToken';

export const AUTH_THROTTLE = {
  signup: { ttl: 3_600_000, limit: 3 },
  login: { ttl: 60_000, limit: 5 },
  refreshToken: { ttl: 60_000, limit: 10 },
  logout: { ttl: 60_000, limit: 10 },
} as const;


export const AUTH_LOCKOUT = {
  maxAttempts: 5, // 同一账号连续登录失败几次后锁定（默认 5）
  lockMinutes: 15, // 锁定持续分钟数：到点自动解锁，无需人工介入，也不会永久误锁
};
