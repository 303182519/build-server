/**
 * 日志脱敏工具
 *
 * 访问日志会把 URL 原样写入磁盘，而 URL 的 query string 里可能携带凭据
 * （OAuth 回调的 ticket / code、token、签名等），一旦明文落盘即为安全事故。
 * 这里只对 query string 做键名匹配脱敏，path 与 hash 保持不变。
 */

/** 需要脱敏的查询参数键（大小写不敏感） */
const SENSITIVE_QUERY_KEYS =
  /^(?:pass(?:word|wd)?|pwd|secret|token|access_?token|refresh_?token|id_?token|api_?key|auth(?:orization)?|code|ticket|signature|sig|credential)$/i;

const REDACTED = '[REDACTED]';

function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey);
  } catch {
    // 非法编码时退化为原始串，避免因脱敏本身抛错影响日志
    return rawKey;
  }
}

/**
 * 对 URL 中的敏感查询参数值做脱敏。
 *
 * @example
 * sanitizeUrl('/auth/github/callback?code=abc&ticket=xyz')
 * // => '/auth/github/callback?code=[REDACTED]&ticket=[REDACTED]'
 */
export function sanitizeUrl(url: string): string {
  if (!url) return url;

  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;

  const prefix = url.slice(0, queryIndex);
  const rest = url.slice(queryIndex + 1);

  const hashIndex = rest.indexOf('#');
  const query = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : rest.slice(hashIndex);

  const sanitized = query
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return pair;
      const rawKey = pair.slice(0, eqIndex);
      return SENSITIVE_QUERY_KEYS.test(decodeKey(rawKey))
        ? `${rawKey}=${REDACTED}`
        : pair;
    })
    .join('&');

  return `${prefix}?${sanitized}${hash}`;
}
