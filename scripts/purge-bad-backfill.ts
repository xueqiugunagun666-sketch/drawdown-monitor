/**
 * 清理口径不一致的回填数据。
 *
 * GMGN 与 DexScreener 会对同一个币给出不同口径的价格（实测相差 100 倍以上）。
 * walletBackfill 现在有守卫拦住，但守卫加上之前已经写进库的脏数据还在，
 * 会继续算出假涨幅。这里把它们找出来删掉。
 *
 * 判据与守卫一致：某个币的 gmgn 回填价与实时价（最新的 wallet-batch
 * 收盘价）相差超过 10 倍，就删掉它全部的 gmgn candle 与对应的 pump_states
 * ——状态是基于错误历史 seed 出来的，也不能留。
 */
import { getRawDb } from '../src/db/index.ts';
import { Decimal } from '../src/lib/decimal.ts';

const MAX_DEVIATION = 10;
const db = getRawDb();
const apply = process.argv.includes('--apply');

const tokens = db.prepare(`
  SELECT DISTINCT token_id FROM candles WHERE timeframe='5m' AND source='gmgn'
`).all() as Array<{ token_id: string }>;

let bad = 0, candlesDeleted = 0, statesDeleted = 0;

for (const { token_id } of tokens) {
  const gm = db.prepare(`
    SELECT c FROM candles WHERE token_id=? AND timeframe='5m' AND source='gmgn'
      AND c IS NOT NULL ORDER BY ts DESC LIMIT 1`).get(token_id) as { c: string } | undefined;
  const live = db.prepare(`
    SELECT c FROM candles WHERE token_id=? AND timeframe='5m' AND source='wallet-batch'
      AND c IS NOT NULL ORDER BY ts DESC LIMIT 1`).get(token_id) as { c: string } | undefined;
  if (!gm?.c || !live?.c) continue;

  const g = new Decimal(gm.c), l = new Decimal(live.c);
  if (!g.gt(0) || !l.gt(0)) continue;
  const ratio = Decimal.max(g.div(l), l.div(g));
  if (ratio.lte(MAX_DEVIATION)) continue;

  bad++;
  const sym = (db.prepare(`SELECT symbol FROM holdings WHERE token_id=? AND symbol IS NOT NULL LIMIT 1`)
    .get(token_id) as { symbol: string } | undefined)?.symbol ?? '?';
  console.log(`  ${sym.padEnd(10)} ${token_id.slice(0, 26)}  回填 ${g} vs 实时 ${l}  差 ${ratio.toFixed(1)} 倍`);

  if (apply) {
    candlesDeleted += db.prepare(
      `DELETE FROM candles WHERE token_id=? AND timeframe='5m' AND source='gmgn'`).run(token_id).changes;
    // 状态是基于错误历史 seed 出来的，一并清掉重新来过
    statesDeleted += db.prepare(`DELETE FROM pump_states WHERE token_id=?`).run(token_id).changes;
  }
}

console.log('');
console.log(`口径不一致的代币: ${bad} 个 / 共检查 ${tokens.length} 个`);
if (apply) console.log(`已删除 ${candlesDeleted} 根 candle、${statesDeleted} 条状态`);
else console.log('（这是预演，加 --apply 才真的删）');
