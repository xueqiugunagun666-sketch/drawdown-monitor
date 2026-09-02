/**
 * 名字清洗 —— 注册、登录用的用户名校验规则。
 *
 * 原来是 src/lib/user.ts 的一部分，服务于已删除的自填署名 cookie 机制。
 * Task 13 删掉那套机制时发现 account 的注册/登录路由也在用同一条清洗规则，
 * 所以单独留下这个文件，其余（USER_COOKIE、readName）随署名机制一起删了。
 */
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
