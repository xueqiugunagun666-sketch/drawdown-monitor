/**
 * ATH 计算 —— 规格 §2.2 / §2.5（v0.3）。
 *
 * ath_robust = 窗口内满足 volume_usd >= vol_floor 的 candle 中，第 k 高的 close
 *   vol_floor = 同窗口非零 volume candle 的中位数 × 0.1
 *   k = ath_sustain_candles，默认 3
 *
 * **回填与实时共用这一段代码** —— 历史段与实时段若用不同标准，
 * 窗口滑动时 ATH 的严格度会悄悄改变。
 *
 * 用 size-k 最小堆维护前 k 大的 close：堆顶即第 k 高。
 * O(n log k)，90 天 26000 根 candle 也不需要全排序。
 */
import { Decimal } from '../lib/decimal.ts';

export interface AthCandle {
  ts: number;
  h: Decimal;
  c: Decimal;
  volumeUsd: number | null;
  /** 回填段为 null —— OHLCV 不提供流动性 */
  liquidityTotal: number | null;
  /** 回填段为 null —— OHLCV 不提供市值 */
  marketCapUsd: number | null;
}

export interface AthResult {
  athRaw: Decimal | null;
  athRobust: Decimal | null;
  athTs: number | null;
  athLiquidity: number | null;
  /** ATH 时刻的市值；回填出的高点为 null，此时**不得**用价格反推 */
  athMarketCap: number | null;
  /** ATH candle 前后各 6 根（共 13 根 65 分钟）的 volume 之和，已归一到 60 分钟 */
  volH1AtAth: number | null;
  athConfidence: 'verified' | 'inferred';
  verdictBasis: 'liquidity' | 'volume_proxy';
  /** 参与 robust 判定的 candle 数，不足 k 时 athRobust 为 null */
  qualifyingCount: number;
  volFloor: number;
}

/**
 * §2.5 的替代分母窗口：ATH candle 前后各 6 格 + 自身 = 13 格。
 *
 * 必须按**时间戳**取，不能按数组下标 —— GeckoTerminal 会省略无成交的 candle，
 * 稀疏数据下 ±6 个下标可能横跨数小时，分母虚大会让 volume_ratio 偏小、
 * verdict 偏悲观。缺失的 candle 本就代表零成交，按时间戳取窗口天然正确。
 *
 * 归一到恰好 3600 秒，因此对任何 timeframe 都得到「ATH 附近的每小时成交量」，
 * 与分子 vol_h1_now 口径一致。5m 时归一系数即 3600/3900 = 12/13。
 */
const H1_HALF_SLOTS = 6;
const H1_TARGET_SECONDS = 3600;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length === 0) return 0;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** size-k 最小堆，保留前 k 大的 close；堆顶 = 第 k 高 */
class TopKHeap {
  private heap: Array<{ c: Decimal; ts: number }> = [];
  constructor(private readonly k: number) {}

  push(c: Decimal, ts: number): void {
    if (this.heap.length < this.k) {
      this.heap.push({ c, ts });
      this.siftUp(this.heap.length - 1);
      return;
    }
    const root = this.heap[0]!;
    // 只有比当前第 k 高更大才有资格进入
    if (c.gt(root.c)) {
      this.heap[0] = { c, ts };
      this.siftDown(0);
    }
  }

  /** 堆顶：前 k 大中的最小者，即第 k 高。不足 k 个时返回 null */
  kth(): { c: Decimal; ts: number } | null {
    return this.heap.length === this.k ? this.heap[0]! : null;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[i]!.c.gte(this.heap[p]!.c)) break;
      [this.heap[i], this.heap[p]] = [this.heap[p]!, this.heap[i]!];
      i = p;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < n && this.heap[l]!.c.lt(this.heap[s]!.c)) s = l;
      if (r < n && this.heap[r]!.c.lt(this.heap[s]!.c)) s = r;
      if (s === i) break;
      [this.heap[i], this.heap[s]] = [this.heap[s]!, this.heap[i]!];
      i = s;
    }
  }
}

/**
 * @param candles 窗口内的 candle，必须按 ts 升序
 * @param k ath_sustain_candles
 * @param tfSeconds candle 的时间粒度（5m=300, 1h=3600），用于 vol_h1_at_ath 的窗口换算
 */
export function computeAth(candles: AthCandle[], k: number, tfSeconds = 300): AthResult {
  const empty: AthResult = {
    athRaw: null, athRobust: null, athTs: null, athLiquidity: null,
    athMarketCap: null, volH1AtAth: null, athConfidence: 'inferred', verdictBasis: 'volume_proxy',
    qualifyingCount: 0, volFloor: 0,
  };
  if (candles.length === 0 || k < 1) return empty;

  // ath_raw：仅作展示
  let athRaw = candles[0]!.h;
  for (const c of candles) if (c.h.gt(athRaw)) athRaw = c.h;

  // vol_floor = 非零 volume 的中位数 × 0.1
  const nonZero = candles.map((c) => c.volumeUsd ?? 0).filter((v) => v > 0);
  const volFloor = nonZero.length > 0 ? median(nonZero) * 0.1 : 0;

  const heap = new TopKHeap(k);
  let qualifyingCount = 0;
  for (const c of candles) {
    if ((c.volumeUsd ?? 0) >= volFloor) {
      qualifyingCount++;
      heap.push(c.c, c.ts);
    }
  }

  const kth = heap.kth();
  if (!kth) {
    // 合格 candle 不足 k 根，robust 值尚不成立
    return { ...empty, athRaw, qualifyingCount, volFloor };
  }

  const athCandle = candles.find((c) => c.ts === kth.ts) ?? null;
  const athLiquidity = athCandle?.liquidityTotal ?? null;
  const athMarketCap = athCandle?.marketCapUsd ?? null;

  // §2.5 替代分母：按时间戳取 ATH 前后各 6 格，归一到 3600 秒
  let volH1AtAth: number | null = null;
  if (athCandle) {
    const half = H1_HALF_SLOTS * tfSeconds;
    const lo = kth.ts - half;
    const hi = kth.ts + half;
    let sum = 0;
    for (const c of candles) {
      if (c.ts < lo) continue;
      if (c.ts > hi) break;
      sum += c.volumeUsd ?? 0;
    }
    const windowSeconds = (2 * H1_HALF_SLOTS + 1) * tfSeconds;
    volH1AtAth = sum * (H1_TARGET_SECONDS / windowSeconds);
  }

  const hasLiquidity = athLiquidity !== null && athLiquidity > 0;
  return {
    athRaw,
    athRobust: kth.c,
    athTs: kth.ts,
    athLiquidity,
    athMarketCap,
    volH1AtAth,
    // 流动性已知 = 该 ATH candle 来自实时轮询；来自 OHLCV 回填则只有六字段
    athConfidence: hasLiquidity ? 'verified' : 'inferred',
    verdictBasis: hasLiquidity ? 'liquidity' : 'volume_proxy',
    qualifyingCount,
    volFloor,
  };
}
