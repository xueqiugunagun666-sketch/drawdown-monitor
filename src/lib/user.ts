/**
 * 用户名 —— 只是**署名**，不是身份。
 *
 * 全站共用一个 ACCESS_TOKEN 登录（见 authToken.ts），进来后填一次用户名存 cookie，
 * 之后加的代币和日程记 created_by。10 个熟人之间做归属追溯够用。
 *
 * 明确的局限：用户名是自己填的、没有单独密码，理论上能冒充他人，
 * 也拦不住谁删别人的东西。要真身份就得上 users 表 + 密码哈希，那是另一件事。
 */
export const USER_COOKIE = 'display_name';
export const MAX_NAME_LENGTH = 24;

/** 控制字符要剔除，否则会污染日志与 Telegram 消息排版 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function sanitizeName(raw: string): string | null {
  const cleaned = raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/** 从请求 cookie 里取用户名；没有返回 null */
export function readName(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]+)`).exec(cookie);
  if (!m?.[1]) return null;
  try {
    return sanitizeName(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}
