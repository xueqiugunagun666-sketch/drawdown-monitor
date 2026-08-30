/** 钱包异动引擎的单币 CPU 成本。与 bench-engine 的 ATH 重算是两回事 */
import { Decimal } from '../src/lib/decimal.ts';
import { computeMultiples, type Candle5m } from '../src/worker/pumpWindows.ts';
import { LEVELS, evaluatePump, initialPumpState, pickWinner, type PendingFire } from '../src/worker/pumpState.ts';
import { evaluateFilter } from '../src/worker/holdingsFilter.ts';

const NOW = Math.floor(Date.now() / 1000);
const CUR = Math.floor(NOW / 300) * 300;
// 24 小时的 5m candle = 288 根，这是窗口计算需要的全部数据
const candles: Candle5m[] = Array.from({ length: 288 }, (_, i) => ({
  ts: CUR - (287 - i) * 300,
  o: (1 + Math.random()).toFixed(12),
  l: (0.5 + Math.random()).toFixed(12),
}));
const price = new Decimal('2.5');

const ROUNDS = 2000;
const t0 = performance.now();
for (let r = 0; r < ROUNDS; r++) {
  evaluateFilter({ monitored: true, belowSinceTs: null },
    { liquidityUsd: 50000, volume24hUsd: 90000 }, NOW);
  const windows = computeMultiples(candles, price, NOW);
  const fires: PendingFire[] = [];
  for (const w of windows) {
    for (const level of LEVELS) {
      const res = evaluatePump(initialPumpState(), { multiple: w.multiple, level, now: NOW });
      if (res.fire) {
        fires.push({ tokenId: 't', timeframe: w.timeframe, basis: w.basis, level, multiple: w.multiple, at: NOW });
      }
    }
  }
  pickWinner(fires);
}
const per = (performance.now() - t0) / ROUNDS;
console.log(`单币一轮判定（288 根 candle × 4 窗口 × 2 基准 × 3 档位）: ${per.toFixed(3)} ms`);
console.log('');
console.log('推算每轮 CPU 耗时（钱包判定周期 120 秒）：');
for (const n of [50, 100, 200, 450]) {
  const total = (per * n) / 1000;
  console.log(`  ${String(n).padStart(4)} 个币   ${total.toFixed(2)}s   占 120 秒预算 ${(total / 120 * 100).toFixed(1)}%`);
}
console.log('');
console.log('注：只算 CPU。网络（批量报价，每 30 个地址一次请求）是并发的，不占 CPU。');
