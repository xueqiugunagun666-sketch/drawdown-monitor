process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate.ts';
import { getRawDb } from '../db/index.ts';
import { Decimal } from '../lib/decimal.ts';
import { backfillWalletToken, needsBackfill, BACKFILL_SECONDS, type BackfillDeps } from './walletBackfill.ts';

before(() => { runMigrations(); });

const NOW = 1_700_000_100;
const CUR = Math.floor(NOW / 300) * 300;

const candle = (ts: number, p: string) => ({
  ts, o: new Decimal(p), h: new Decimal(p), l: new Decimal(p), c: new Decimal(p), volumeUsd: 100,
});

const deps = (rows: ReturnType<typeof candle>[]): BackfillDeps => ({
  fetchKline: async () => rows,
  supportsChain: () => true,
  isConfigured: () => true,
});

test('回填窗口是 24 小时', () => {
  assert.equal(BACKFILL_SECONDS, 86400);
});

test('没有任何 candle 的币需要回填', () => {
  assert.equal(needsBackfill('bsc:0xnone', NOW), true);
});

test('已有覆盖 24h 的历史就不再回填', () => {
  const db = getRawDb();
  const st = db.prepare(`INSERT INTO candles (token_id,timeframe,ts,o,h,l,c) VALUES (?, '5m', ?, '1','1','1','1')`);
  for (let i = 288; i >= 0; i--) st.run('bsc:0xfull', CUR - i * 300);
  assert.equal(needsBackfill('bsc:0xfull', NOW), false);
});

test('只有几根新 candle 的币仍需回填', () => {
  const db = getRawDb();
  db.prepare(`INSERT INTO candles (token_id,timeframe,ts,o,h,l,c) VALUES ('bsc:0xthin','5m',?, '1','1','1','1')`).run(CUR);
  assert.equal(needsBackfill('bsc:0xthin', NOW), true);
});

test('回填写入的 candle 可被窗口计算读到', async () => {
  // 24h 内的 288 根完整历史桶，不包含当前仍在形成的桶。
  const rows = Array.from({ length: 288 }, (_, i) => candle(CUR - (288 - i) * 300, '2'));
  const n = await backfillWalletToken('bsc:0xbf', NOW, deps(rows));
  assert.equal(n, 288);
  const cnt = getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id='bsc:0xbf' AND timeframe='5m'`).get() as { c: number };
  assert.equal(cnt.c, 288);
});

test('回填不覆盖已有的实时 candle', () => {
  // 实时写的带流动性与成交笔数，回填只有 OHLCV 六字段。
  // 覆盖会把 ath_confidence 从 verified 降成 inferred
  const db = getRawDb();
  db.prepare(
    `INSERT INTO candles (token_id,timeframe,ts,o,h,l,c,liquidity_total,source)
     VALUES ('bsc:0xkeep','5m',?, '9','9','9','9', 12345, 'wallet-batch')`).run(CUR);
  return backfillWalletToken('bsc:0xkeep', NOW, deps([candle(CUR, '1')])).then((n) => {
    assert.equal(n, 0, '当前未完成桶不应由 GMGN 写入');
    const row = db.prepare(
      `SELECT o, liquidity_total, source FROM candles WHERE token_id='bsc:0xkeep' AND ts=?`).get(CUR) as
      { o: string; liquidity_total: number; source: string };
    assert.equal(row.o, '9', '实时数据不该被回填覆盖');
    assert.equal(row.liquidity_total, 12345);
    assert.equal(row.source, 'wallet-batch');
  });
});

test('上游乱序、未来、当前桶和重复 ts 会先规范化', async () => {
  const rows = [
    candle(CUR + 300, '99'),                 // 未来
    candle(CUR, '88'),                       // 当前未完成桶
    candle(CUR - 300, '2'),
    candle(CUR - 600, '1'),
    candle(CUR - 300, '3'),                  // 同 ts 重复：取排序后的最后一条
    candle(CUR - BACKFILL_SECONDS - 300, '0'), // 窗口外
  ];
  const n = await backfillWalletToken('bsc:0xnormalize', NOW, deps(rows));
  assert.equal(n, 2);
  const stored = getRawDb().prepare(
    `SELECT ts, c FROM candles WHERE token_id='bsc:0xnormalize' ORDER BY ts`,
  ).all() as Array<{ ts: number; c: string }>;
  assert.deepEqual(stored, [
    { ts: CUR - 600, c: '1' },
    { ts: CUR - 300, c: '3' },
  ]);
});

test('回填的 candle 标记来源为 gmgn，与实时数据可区分', async () => {
  await backfillWalletToken('bsc:0xsrc', NOW, deps([candle(CUR - 3000, '1')]));
  const row = getRawDb().prepare(
    `SELECT source FROM candles WHERE token_id='bsc:0xsrc' AND ts=?`).get(CUR - 3000) as { source: string };
  assert.equal(row.source, 'gmgn');
});

test('超出 24h 窗口的 candle 被丢弃，不无限增长', async () => {
  const rows = [candle(CUR - 200000, '1'), candle(CUR - 600, '2')];
  const n = await backfillWalletToken('bsc:0xtrim', NOW, deps(rows));
  assert.equal(n, 1, '只该写窗口内那根');
});

test('GMGN 未配置时跳过且不抛错', async () => {
  const n = await backfillWalletToken('bsc:0xnokey', NOW, {
    ...deps([candle(CUR, '1')]), isConfigured: () => false,
  });
  assert.equal(n, 0);
});

test('GMGN 不支持的链跳过且不抛错', async () => {
  const n = await backfillWalletToken('solana:xyz', NOW, {
    ...deps([candle(CUR, '1')]), supportsChain: () => false,
  });
  assert.equal(n, 0);
});

test('拉取失败不抛出，返回 0 —— 回填是尽力而为，不能拖垮判定循环', async () => {
  const n = await backfillWalletToken('bsc:0xfail', NOW, {
    ...deps([]), fetchKline: async () => { throw new Error('GMGN 429'); },
  });
  assert.equal(n, 0);
});

test('价格全程走字符串，极小价格不丢精度', async () => {
  await backfillWalletToken('bsc:0xprec', NOW, deps([candle(CUR - 900, '0.000000000001234')]));
  const row = getRawDb().prepare(
    `SELECT o FROM candles WHERE token_id='bsc:0xprec' AND ts=?`).get(CUR - 900) as { o: string };
  assert.equal(row.o, '0.000000000001234');
});

test('回填价与实时价差太多时整批丢弃 —— 两个源不在一个口径上', async () => {
  // 实测：不对劲 GMGN 报 3.0e-05、DexScreener 报 0.0038，差 126 倍；
  // 哈夫币差 119 倍。这不是暴涨（相隔仅几十分钟），是口径不一致。
  // 混进同一条 candle 序列会算出 100 多倍的假涨幅
  const rows = Array.from({ length: 288 }, (_, i) =>
    candle(CUR - (287 - i) * 300, '0.000030'));
  const n = await backfillWalletToken('bsc:0xmismatch', NOW, deps(rows), new Decimal('0.0038'));
  assert.equal(n, 0, '差 126 倍必须整批丢弃');
  const cnt = getRawDb().prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id='bsc:0xmismatch'`).get() as { c: number };
  assert.equal(cnt.c, 0);
});

test('回填价与实时价接近时正常写入', async () => {
  const rows = Array.from({ length: 288 }, (_, i) =>
    candle(CUR - (288 - i) * 300, '0.0000016'));
  const n = await backfillWalletToken('bsc:0xagree', NOW, deps(rows), new Decimal('0.0000016150'));
  assert.equal(n, 288, '基本一致就该正常写入');
});

test('真实涨幅落在容忍区间内，不会被误杀', async () => {
  // 币在回填窗口内从 1 涨到 2.5，实时价 2.5 —— 最后一根 K 线也是 2.5，
  // 判据是"最后一根 vs 实时"而不是"最低价 vs 实时"，所以不受涨幅影响
  const rows = Array.from({ length: 288 }, (_, i) =>
    candle(CUR - (288 - i) * 300, i < 200 ? '1' : '2.5'));
  const n = await backfillWalletToken('bsc:0xrose', NOW, deps(rows), new Decimal('2.5'));
  assert.equal(n, 288, '真实上涨不该被守卫拦掉');
});

test('两个已完成重叠样本稳定为恒定 3x 时整批拒绝', async () => {
  const db = getRawDb();
  const live = db.prepare(
    `INSERT INTO candles (token_id,timeframe,ts,o,h,l,c,source)
     VALUES ('bsc:0xconstant3','5m',?,?,?,?,?, 'wallet-batch')`,
  );
  live.run(CUR - 600, '1', '1', '1', '1');
  live.run(CUR - 300, '2', '2', '2', '2');

  const rows = [candle(CUR - 600, '3'), candle(CUR - 300, '6'), candle(CUR - 900, '1')];
  const n = await backfillWalletToken('bsc:0xconstant3', NOW, deps(rows), new Decimal('6'));
  assert.equal(n, 0, '恒定 3x 口径不能整批写入');
  const gmgn = db.prepare(
    `SELECT COUNT(*) c FROM candles WHERE token_id='bsc:0xconstant3' AND source='gmgn'`,
  ).get() as { c: number };
  assert.equal(gmgn.c, 0);
});

test('来源为空的旧 candle 不能冒充可信实时重叠样本', async () => {
  const db = getRawDb();
  const legacy = db.prepare(
    `INSERT INTO candles (token_id,timeframe,ts,o,h,l,c,source)
     VALUES ('bsc:0xlegacy-overlap','5m',?,?,?,?,?, NULL)`,
  );
  legacy.run(CUR - 600, '1', '1', '1', '1');
  legacy.run(CUR - 300, '2', '2', '2', '2');
  const rows = [
    candle(CUR - 900, '3'), candle(CUR - 600, '3'), candle(CUR - 300, '6'),
  ];
  const n = await backfillWalletToken('bsc:0xlegacy-overlap', NOW, deps(rows), null);
  assert.equal(n, 1, '旧行只负责防覆盖，不能作为拒绝整批的可信证据');
});

test('真实趋势造成的不同步倍率不稳定时不误拒', async () => {
  const db = getRawDb();
  const live = db.prepare(
    `INSERT INTO candles (token_id,timeframe,ts,o,h,l,c,source)
     VALUES ('bsc:0xtrend','5m',?,?,?,?,?, 'wallet-dexscreener')`,
  );
  live.run(CUR - 600, '1', '1', '1', '1');
  live.run(CUR - 300, '2', '2', '2', '2');

  // 两个同 ts 样本分别约 2x / 4x，说明是不同步趋势，不是稳定源倍率。
  // 即使当前价已经从历史最新值继续上涨，也不能走 10x 单点误杀。
  const rows = [candle(CUR - 900, '0.5'), candle(CUR - 600, '2'), candle(CUR - 300, '8')];
  const n = await backfillWalletToken('bsc:0xtrend', NOW, deps(rows), new Decimal('120'));
  assert.equal(n, 1, '不同步的真实趋势不应被恒定倍率规则拒绝');
});

test('重叠不足但最新历史很旧时，1 到 12 的真实上涨不被 10x fallback 误杀', async () => {
  const oldTs = CUR - 2 * 3600;
  const n = await backfillWalletToken(
    'bsc:0xoldtrend', NOW, deps([candle(oldTs, '1')]), new Decimal('12'),
  );
  assert.equal(n, 1, '旧历史不能作为 10x 口径拒绝的依据');
});

test('刚好在容忍边界内外', async () => {
  const mk = (p: string) => Array.from({ length: 10 }, (_, i) => candle(CUR - (9 - i) * 300, p));
  // 容忍 10 倍：9.5 倍放行，11 倍拦下。
  // 偏向拦截：拦错了只是没历史，放过了就是假报警
  assert.ok(await backfillWalletToken('bsc:0xin', NOW, deps(mk('1')), new Decimal('9.5')) > 0);
  assert.equal(await backfillWalletToken('bsc:0xout', NOW, deps(mk('1')), new Decimal('11')), 0);
});

test('反向偏离同样拦下 —— 回填价高于实时价也是口径问题', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => candle(CUR - (9 - i) * 300, '100'));
  assert.equal(await backfillWalletToken('bsc:0xrev', NOW, deps(rows), new Decimal('1')), 0);
});

test('没有实时价时跳过守卫，照常写入', async () => {
  // 拿不到实时价就无从比较。此时宁可写入——没有历史比有可疑历史更糟
  const n = await backfillWalletToken('bsc:0xnolive', NOW, deps([candle(CUR - 900, '1')]), null);
  assert.equal(n, 1);
});
