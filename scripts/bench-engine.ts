/**
 * 引擎耗时基准：估算 N 个代币在一台机器上能不能跑完 30 秒一轮。
 *   npm run bench
 */
import { computeForMode, ATH_MODES, QUOTE_MODES } from '../src/worker/athModes.ts';
import { nowSec } from '../src/lib/time.ts';
import * as repo from '../src/db/repo.ts';

const tokens = repo.listAllTokens();
const now = nowSec();

console.log('单代币「重算全部 ATH」耗时（3 模式 × 2 计价 = 6 组）：\n');
const perToken: Array<[string, number, number]> = [];

for (const t of tokens) {
  const n5 = repo.getCandles(t.id, '5m', 0).length;
  const n1 = repo.getCandles(t.id, '1h', 0).length;
  if (n5 + n1 === 0) continue;

  const t0 = process.hrtime.bigint();
  const ROUNDS = 5;
  for (let i = 0; i < ROUNDS; i++) {
    for (const mode of ATH_MODES) {
      for (const qm of QUOTE_MODES) {
        computeForMode(t.id, mode, qm, 3, t.addedAt, now);
      }
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / ROUNDS;
  perToken.push([t.symbol ?? t.id, n5 + n1, ms]);
  console.log(`  ${(t.symbol ?? t.id).padEnd(10)} ${String(n5 + n1).padStart(6)} 根 candle  ->  ${ms.toFixed(1)} ms`);
}

if (perToken.length === 0) { console.log('  还没有数据'); process.exit(0); }

// 按「每根 candle 的耗时」折算到满负荷，现有代币都还没回填满
const totalCandles = perToken.reduce((s, x) => s + x[1], 0);
const totalMs = perToken.reduce((s, x) => s + x[2], 0);
const msPerCandle = totalMs / totalCandles;

// 满负荷单币：90 天 5m + 180 天 1h
const FULL = 90 * 288 + 180 * 24;
const fullMs = msPerCandle * FULL;
console.log(`每根 candle 约 ${(msPerCandle * 1000).toFixed(2)} 微秒`);
console.log(`满负荷单币（${FULL} 根，90天5m + 180天1h）折算：${fullMs.toFixed(0)} ms\n`);

console.log('推算每轮 CPU 耗时（预算 30 秒）：');
console.log('  代币数    单核串行     2 核并行    占 30 秒预算');
for (const n of [10, 20, 50, 100]) {
  const serial = (fullMs * n) / 1000;
  const twoCore = serial / 2;
  const pct = (twoCore / 30) * 100;
  const flag = pct > 80 ? '   <-- 跑不完' : pct > 50 ? '   <-- 吃紧' : '';
  console.log(`  ${String(n).padStart(4)}    ${serial.toFixed(1).padStart(7)}s    ${twoCore.toFixed(1).padStart(7)}s    ${pct.toFixed(0).padStart(5)}%${flag}`);
}
console.log('\n注 1：只算 CPU，网络等待是并发的、不占 CPU。');
console.log('注 2：本机是 macOS 开发机，云上 2 核性能通常略低，按 1.5 倍留余量看。');
