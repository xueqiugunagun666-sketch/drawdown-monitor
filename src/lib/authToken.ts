/**
 * ACCESS_TOKEN 的比较与登录限流。
 *
 * 单用户/小圈子工具，不做用户系统（规格 §10）——
 * 一个长随机口令，登录后写 httpOnly cookie。
 */
import { timingSafeEqual } from 'node:crypto';

/** 恒定时间比较，避免通过响应时间逐字符猜口令 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // 长度不同时 timingSafeEqual 会抛错，先用等长缓冲区比一次维持恒定时间
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** 按 IP 的登录失败限流：10 分钟内最多 8 次 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (rec.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((rec.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count++;
  }
}

export function clearFailures(ip: string): void {
  attempts.delete(ip);
}

/** 从反代后面拿真实 IP */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export const COOKIE_NAME = 'access_token';
