import Link from 'next/link';
import Nav from '../components/Nav.tsx';
import TokenActions from '../components/TokenActions.tsx';
import { getConfig } from '../lib/config.ts';
import { priceFromText, drawdownPct, formatPrice } from '../lib/decimal.ts';
import { nowSec, humanAgo } from '../lib/time.ts';
import { ATH_MODES, type AthMode } from '../worker/athModes.ts';
import { backfillProgress } from '../worker/backfill.ts';
import * as repo from '../db/repo.ts';

export const dynamic = 'force-dynamic';

const MODE_LABEL: Record<AthMode, string> = {
  rolling_90d: '90 天',
  since_added: '加入以来',
  all_time: '全历史',
};

/**
 * 回撤格式化。ath_robust 是第 k 高的 close，现价高于它时回撤为负，
 * 此时应显示 +X%（高于该基准）而不是 --X%。
 */
function fmtDd(dd: { toNumber(): number; toFixed(n: number): string } | null, digits = 1): string {
  if (!dd) return '—';
  const n = dd.toNumber();
  return n >= 0 ? `-${dd.toFixed(digits)}%` : `+${Math.abs(n).toFixed(digits)}%`;
}

function ddColor(pct: number | null): string {
  if (pct === null) return 'text-neutral-600';
  if (pct >= 80) return 'text-red-400';
  if (pct >= 50) return 'text-amber-400';
  return 'text-neutral-400';
}

export default function Home() {
  const cfg = getConfig();
  const tokens = repo.listAllTokens();
  const lastRun = repo.getLastPollRun();
  const bf = backfillProgress();
  const now = nowSec();
  const staleCutoff = now - cfg.polling.staleMinutes * 60;
  const activeMode = (cfg.defaultRule.athMode ?? 'rolling_90d') as AthMode;
  const level0 = cfg.defaultRule.levels[0] ?? 80;

  const rows = tokens.map((t) => {
    const candles = repo.getCandles(t.id, '5m', 0);
    const price = priceFromText(candles.at(-1)?.c ?? null);
    const priceNative = priceFromText(candles.at(-1)?.cNative ?? null);

    const perMode = ATH_MODES.map((mode) => {
      const a = repo.getAth(t.id, mode, 'usd');
      const robust = priceFromText(a?.athRobust ?? null);
      return { mode, ath: a, robust, dd: price && robust ? drawdownPct(robust, price) : null };
    });
    const active = perMode.find((m) => m.mode === activeMode)!;

    const athNative = priceFromText(repo.getAth(t.id, activeMode, 'native')?.athRobust ?? null);
    const ddNative = priceNative && athNative ? drawdownPct(athNative, priceNative) : null;

    const pools = repo.listPools(t.id);
    const state = repo.getAlertState(t.id, 'default', level0);
    const isStale = t.enabled === 1 && t.frozen === 0 && (t.lastQuoteAt === null || t.lastQuoteAt < staleCutoff);
    return { t, price, perMode, active, ddNative, pools, state, isStale };
  }).sort((a, b) => (b.active.dd?.toNumber() ?? -1) - (a.active.dd?.toNumber() ?? -1));

  const staleCount = rows.filter((r) => r.isStale).length;
  const firedCount = rows.filter((r) => r.state.state === 'FIRED').length;

  return (
    <main className="p-4 md:p-8 max-w-[1600px] mx-auto">
      <Nav current="/" />
      <h1 className="text-xl font-semibold mb-1">回撤监控</h1>
      <p className="text-xs text-neutral-500 mb-4">
        当前规则 · {MODE_LABEL[activeMode]}（{activeMode}）· {cfg.defaultRule.quoteMode.toUpperCase()} 计价 ·
        档位 {JSON.stringify(cfg.defaultRule.levels)} · k={cfg.defaultRule.athSustainCandles}
      </p>

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

      {bf.jobs > 0 && bf.done < bf.jobs && (
        <div className="mb-4 p-3 rounded border border-sky-900 bg-sky-950/30 text-sm text-sky-300">
          <div className="flex justify-between mb-2">
            <span>历史回填中 {bf.pct}% · {bf.done}/{bf.jobs} 任务 · {bf.pagesDone}/{bf.pagesTotal} 页</span>
            <span className="text-xs text-sky-400/70">预计还需 {bf.etaMinutes} 分钟（数据源限速 5 请求/分钟）</span>
          </div>
          <div className="h-1 bg-sky-950 rounded overflow-hidden">
            <div className="h-full bg-sky-500" style={{ width: `${bf.pct}%` }} />
          </div>
          <div className="text-xs text-sky-400/70 mt-2">回填完成前，90 天与全历史的 ATH 尚不完整</div>
        </div>
      )}

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
              <th className="py-2 pr-4">回撤 ({MODE_LABEL[activeMode]})</th>
              <th className="py-2 pr-4">原生币计价</th>
              <th className="py-2 pr-4">三种 ATH</th>
              <th className="py-2 pr-4">流动性(总)</th>
              <th className="py-2 pr-4">主池</th>
              <th className="py-2 pr-4">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, price, perMode, active, ddNative, pools, state, isStale }) => {
              const primary = pools.find((p) => p.isPrimary === 1);
              const outliers = pools.filter((p) => p.isOutlier === 1).length;
              const liqTotal = pools.filter((p) => p.isOutlier === 0).reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);
              const share = primary && liqTotal > 0 ? (primary.liquidityUsd ?? 0) / liqTotal : 1;
              return (
                <tr key={t.id} className="border-b border-neutral-900 align-top">
                  <td className="py-2 pr-4">
                    <Link href={`/token/${encodeURIComponent(t.id)}`}
                      className="font-medium hover:text-sky-400 hover:underline">
                      {t.symbol ?? t.address.slice(0, 8)}
                    </Link>
                    <div className="text-xs text-neutral-500">{t.chain}</div>
                    {/* 备注用琥珀色：报警弹出来时最需要回忆的就是当初为什么关注它，
                            混在灰字里会被忽略 */}
                    {t.note && <div className="text-xs text-amber-500/90 max-w-[200px] mt-1">{t.note}</div>}
                    <TokenActions tokenId={t.id} symbol={t.symbol} note={t.note}
                      frozen={t.frozen === 1} enabled={t.enabled === 1} />
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{price ? `$${formatPrice(price, 6)}` : '—'}</td>
                  <td className={`py-2 pr-4 tabular-nums font-medium ${ddColor(active.dd?.toNumber() ?? null)}`}>
                    {active.dd ? fmtDd(active.dd) : <span className="text-neutral-600">数据不足</span>}
                    {active.ath?.athTs && (
                      <div className="text-xs text-neutral-600 font-normal">高点 {humanAgo(active.ath.athTs, now)}</div>
                    )}
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-neutral-400">
                    {fmtDd(ddNative)}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-col gap-0.5 text-xs">
                      {perMode.map(({ mode, ath, robust, dd }) => (
                        <div key={mode} className="flex gap-2 items-baseline">
                          <span className="text-neutral-600 w-14">{MODE_LABEL[mode]}</span>
                          <span className="tabular-nums text-neutral-400">
                            {robust ? `$${formatPrice(robust, 5)}` : '—'}
                          </span>
                          <span className={`tabular-nums ${ddColor(dd?.toNumber() ?? null)}`}>
                            {dd ? fmtDd(dd, 0) : ''}
                          </span>
                          {ath?.backfillPartial === 1 && (
                            <span className="text-amber-500/80" title="数据源历史深度不足，窗口未被完整覆盖">不完整</span>
                          )}
                          {ath?.athConfidence === 'inferred' && robust && (
                            <span className="text-neutral-600" title="高点来自回填数据，无流动性与成交笔数">推断</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    ${Math.round(liqTotal).toLocaleString()}
                    <div className="text-xs text-neutral-600">
                      {pools.length} 池{outliers > 0 ? ` · 剔除 ${outliers}` : ''}
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-xs text-neutral-400">
                    {primary ? `${primary.dex} / ${primary.quoteSymbol}` : '—'}
                    {share < 0.5 && (
                      <div className="text-amber-500/80">主池仅占 {(share * 100).toFixed(0)}%</div>
                    )}
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
          清单为空。<Link href="/add" className="text-sky-400 hover:underline">去加币</Link>。
        </p>
      )}
    </main>
  );
}
