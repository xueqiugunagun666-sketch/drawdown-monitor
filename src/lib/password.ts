/**
 * 密码哈希 —— scrypt，用 Node 内置 crypto，不引入 bcrypt/argon2 依赖。
 *
 * 存储格式：scrypt$N$r$p$salt_b64$hash_b64
 * 参数存进串里，以后想调强度可以直接改常量，老密码照旧能验。
 *
 * 校验用 timingSafeEqual 而不是 ===：按字节短路比较会泄露
 * "前几位对了"这个信息，理论上可以逐位爆破。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  pw: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16384, r = 8, p = 1, KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, sN, sr, sp, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64 ?? '', 'base64');
    const expected = Buffer.from(hashB64 ?? '', 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const nN = Number(sN), nr = Number(sr), np = Number(sp);
    if (!Number.isFinite(nN) || !Number.isFinite(nr) || !Number.isFinite(np)) return false;
    const key = await scryptAsync(password, salt, expected.length, { N: nN, r: nr, p: np });
    // timingSafeEqual 对不等长 Buffer 会抛 RangeError，必须先比长度
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    // 任何异常都返回 false —— 抛出去会让登录接口 500，
    // 从而泄露"这个用户存在但数据坏了"
    return false;
  }
}
