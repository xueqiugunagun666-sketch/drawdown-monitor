/**
 * 单用户鉴权（§10）：一个长随机 ACCESS_TOKEN 做 Bearer 校验，不实现用户系统。
 */
import { getSecrets } from './config.ts';
import { makeLogger } from './log.ts';

const log = makeLogger('auth');
let warned = false;

export function checkAuth(req: Request): { ok: true } | { ok: false; reason: string } {
  const { accessToken } = getSecrets();
  if (!accessToken) {
    if (!warned) {
      warned = true;
      log.warn('ACCESS_TOKEN 未配置，API 未鉴权 —— 仅可用于本地开发');
    }
    return { ok: true };
  }
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cookie = req.headers.get('cookie') ?? '';
  const fromCookie = /(?:^|;\s*)access_token=([^;]+)/.exec(cookie)?.[1];
  const provided = bearer ?? (fromCookie ? decodeURIComponent(fromCookie) : null);
  if (provided !== accessToken) return { ok: false, reason: '未授权' };
  return { ok: true };
}
