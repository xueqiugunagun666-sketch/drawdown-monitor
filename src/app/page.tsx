import { getConfig } from '../lib/config.ts';
import { priceFromText, drawdownPct, formatPrice } from '../lib/decimal.ts';
import { nowSec, humanAgo } from '../lib/time.ts';
import * as repo from '../db/repo.ts';

export const dynamic = 'force-dynamic';

function drawdownColor(pct: number | null): string {
  if (pct === null) return 'text-neutral-500';
  if (pct >= 80) return 'text-red-400';
  if (pct >= 50) return 'text-amber-400';
  return 'text-neutral-400';
}

export default function Home() {
  const cfg = getConfig();
  const tokens = repo.listAllTokens();
  const lastRun = repo.getLastPollRun();
  const now = nowSec();
  const staleCutoff = now - cfg.polling.staleMinutes * 60;

  const rows = tokens.map((t) => {
    const ath = repo.getAth(t.id, 'since_added', 'usd');
    const candles = repo.getCandles(t.id, '5m', 0);
    const last = candles.at(-1);
    const price = priceFromText(last?.c ?? null);
    const robust = priceFromText(ath?.athRobust ?? null);
    const dd = price && robust ? drawdownPct(robust, price) : null;
    const pools = repo.listPools(t.id);
    const state = repo.getAlertState(t.id, 'default', cfg.defaultRule.levels[0] ?? 80);
    const isStale = t.enabled === 1 && t.frozen === 0 && (t.lastQuoteAt === null || t.lastQuoteAt < staleCutoff);
    return { t, ath, price, robust, dd, pools, state, isStale, last };
  }).sort((a, b) => (b.dd?.toNumber() ?? -1) - (a.dd?.toNumber() ?? -1));

  const staleCount = rows.filter((r) => r.isStale).length;
  const firedCount = rows.filter((r) => r.state.state === 'FIRED').length;

  return (
    <main className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <h1 className="text-xl font-semibold mb-1">回撤监控</h1>
      <p className="text-xs text-neutral-500 mb-4">
        Phase 1 · since_added 模式 · USD 计价 · 档位 {JSON.stringify(cfg.defaultRule.levels)}
      </p>

      {/* 顶部指标条 */}
      <div className="flex flex-wrap gap-3 text-xs mb-4">
        <span className="px-2 py-1 rounded bg-neutral-900">清单 {tokens.length}</span>
        <span className="px-2 py-1 rounded bg-neutral-900">FIRED {firedCount}</span>
        <span className={`px-2 py-1 rounded ${staleCount ? 'bg-red-950 text-red-300' : 'bg-neutral-900'}`}>
          失联 {staleCount}
        </span>
        <span className="px-2 py-1 rounded bg-neutral-900">
          上次轮询 {lastRun?.finishedAt ? `${humanAgo(lastRun.finishedAt, now)} (${lastRun.tokensCovered}/${lastRun.tokensRequested})` : '尚未运行'}
        </span>
      </div>

      {/* 失效必须显式暴露，不能只在日志里 */}
      {staleCount > 0 && (
        <div className="mb-4 p-3 rounded border border-red-900 bg-red-950/40 text-sm text-red-300">
          {staleCount} 个代币超过 {cfg.polling.staleMinutes} 分钟无有效报价 —— 数据源可能失联
        </div>
      )}
      {lastRun?.errors && (
        <div className="mb-4 p-3 rounded border border-amber-900 bg-amber-950/30 text-xs text-amber-300">
          <div className="font-medium mb-1">上轮错误</div>
          {(JSON.parse(lastRun.errors) as string[]).map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-neutral-500 border-b border-neutral-800">
              <th className="py-2 pr-4">代币</th>
              <th className="py-2 pr-4">当前价</th>
              <th className="py-2 pr-4">ATH (robust)</th>
              <th className="py-2 pr-4">回撤</th>
              <th className="py-2 pr-4">流动性(总)</th>
              <th className="py-2 pr-4">主池</th>
              <th className="py-2 pr-4">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, ath, price, robust, dd, pools, state, isStale }) => {
              const primary = pools.find((p) => p.isPrimary === 1);
              const outliers = pools.filter((p) => p.isOutlier === 1).length;
              const liqTotal = pools.filter((p) => p.isOutlier === 0)
                .reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);
              return (
                <tr key={t.id} className="border-b border-neutral-900 align-top">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{t.symbol ?? '—'}</div>
                    <div className="text-xs text-neutral-500">{t.chain}</div>
                    {t.note && <div className="text-xs text-neutral-600 max-w-[220px] mt-1">{t.note}</div>}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{price ? `$${formatPrice(price, 6)}` : '—'}</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {robust ? `$${formatPrice(robust, 6)}` : <span className="text-neutral-600">数据不足</span>}
                    {ath?.athTs && <div className="text-xs text-neutral-600">{humanAgo(ath.athTs, now)}</div>}
                    {ath?.athConfidence && robust && (
                      <div className="text-xs text-neutral-600">{ath.athConfidence}</div>
                    )}
                  </td>
                  <td className={`py-2 pr-4 tabular-nums font-medium ${drawdownColor(dd?.toNumber() ?? null)}`}>
                    {dd ? `-${dd.toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    ${Math.round(liqTotal).toLocaleString()}
                    <div className="text-xs text-neutral-600">{pools.length} 池{outliers > 0 ? ` · 剔除 ${outliers}` : ''}</div>
                  </td>
                  <td className="py-2 pr-4 text-xs text-neutral-400">
                    {primary ? `${primary.dex} / ${primary.quoteSymbol}` : '—'}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      state.state === 'FIRED' ? 'bg-red-950 text-red-300' : 'bg-neutral-900 text-neutral-400'
                    }`}>{state.state}</span>
                    {isStale && <div className="text-xs text-red-400 mt-1">失联</div>}
                    {t.frozen === 1 && <div className="text-xs text-neutral-500 mt-1">FROZEN</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {tokens.length === 0 && (
        <p className="text-sm text-neutral-500 mt-6">
          清单为空。用 <code className="text-neutral-400">npm run token:add -- &lt;chain&gt; &lt;address&gt; &quot;备注&quot;</code> 添加。
        </p>
      )}
    </main>
  );
}
