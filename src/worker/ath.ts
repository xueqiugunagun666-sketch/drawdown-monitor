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
  /** 回填段为 null —— GT OHLCV 不提供流动性 */
  liquidityTotal: number | null;
}

export interface AthResult {
  athRaw: Decimal | null;
  athRobust: Decimal | null;
  athTs: number | null;
  athLiquidity: number | null;
  /** ATH candle 前后各 6 根（共 13 根 65 分钟）的 volume 之和，已归一到 60 分钟 */
  volH1AtAth: number | null;
  athConfidence: 'verified' | 'inferred';
  verdictBasis: 'liquidity' | 'volume_proxy';
  /** 参与 robust 判定的 candle 数，不足 k 时 athRobust 为 null */
  qualifyingCount: number;
  volFloor: number;
}

/** 前后各 6 根 + 自身 = 13 根 = 65 分钟，归一到 60 分钟 */
const H1_HALF_WINDOW = 6;
const H1_NORMALIZE = 12 / 13;

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
 */
export function computeAth(candles: AthCandle[], k: number): AthResult {
  const empty: AthResult = {
    athRaw: null, athRobust: null, athTs: null, athLiquidity: null,
    volH1AtAth: null, athConfidence: 'inferred', verdictBasis: 'volume_proxy',
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

  const idx = candles.findIndex((c) => c.ts === kth.ts);
  const athCandle = idx >= 0 ? candles[idx]! : null;
  const athLiquidity = athCandle?.liquidityTotal ?? null;

  // §2.5 替代分母：ATH candle 前后各 6 根，归一到 60 分钟
  let volH1AtAth: number | null = null;
  if (idx >= 0) {
    const lo = Math.max(0, idx - H1_HALF_WINDOW);
    const hi = Math.min(candles.length - 1, idx + H1_HALF_WINDOW);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += candles[i]!.volumeUsd ?? 0;
    volH1AtAth = sum * H1_NORMALIZE;
  }

  const hasLiquidity = athLiquidity !== null && athLiquidity > 0;
  return {
    athRaw,
    athRobust: kth.c,
    athTs: kth.ts,
    athLiquidity,
    volH1AtAth,
    // 流动性已知 = 该 ATH candle 来自实时轮询；来自 OHLCV 回填则只有六字段
    athConfidence: hasLiquidity ? 'verified' : 'inferred',
    verdictBasis: hasLiquidity ? 'liquidity' : 'volume_proxy',
    qualifyingCount,
    volFloor,
  };
}
