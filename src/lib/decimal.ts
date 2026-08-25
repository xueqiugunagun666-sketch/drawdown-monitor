/**
 * 全局 Decimal 配置与价格辅助函数。
 *
 * 绝对规则：价格算术一律走 Decimal，禁止 JS number。
 * Memecoin 价格常在 1e-12 量级，number 的浮点误差会让 79.98% / 80.02%
 * 在阈值边界抖动。
 *
 * 存储约定：价格列在 SQLite 里是 TEXT（十进制字符串）。
 * 数据源返回的就是字符串，全程 字符串 -> Decimal -> 字符串，两端都不经过 float。
 */
import Decimal from 'decimal.js';

Decimal.set({
  precision: 40,
  // 让 toString() 在 1e-12 这种量级仍输出普通小数而非指数形式，
  // 便于人眼阅读与 SQL 里的字典序比较
  toExpNeg: -40,
  toExpPos: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export { Decimal };

/** 解析数据源返回的价格字符串；无效值返回 null 而不是 NaN/0 */
export function parsePrice(raw: string | number | null | undefined): Decimal | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const d = new Decimal(raw);
    if (!d.isFinite() || d.isNegative()) return null;
    return d;
  } catch {
    return null;
  }
}

/** 写库用的规范字符串 */
export function priceToText(d: Decimal): string {
  return d.toString();
}

/** 从库里读回 */
export function priceFromText(text: string | null | undefined): Decimal | null {
  return parsePrice(text);
}

/**
 * 回撤百分比 = (ath - price) / ath * 100
 * ath <= 0 时返回 null（无意义），不返回 0 —— 0 会被误读成"没有回撤"。
 */
export function drawdownPct(ath: Decimal, price: Decimal): Decimal | null {
  if (ath.lte(0)) return null;
  return ath.minus(price).div(ath).mul(100);
}

/** 展示用：保留 n 位有效数字 */
export function formatPrice(d: Decimal, sig = 6): string {
  return d.toSignificantDigits(sig).toString();
}
