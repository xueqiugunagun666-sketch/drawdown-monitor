import Link from 'next/link';
import { notFound } from 'next/navigation';
import Nav from '../../../components/Nav.tsx';
import Chart, { type PriceLine } from './Chart.tsx';
import { getConfig } from '../../../lib/config.ts';
import { priceFromText, drawdownPct, formatPrice } from '../../../lib/decimal.ts';
import { nowSec, humanAgo, fmtUtc } from '../../../lib/time.ts';
import { ATH_MODES, specFor, type AthMode } from '../../../worker/athModes.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

const MODE_LABEL: Record<AthMode, string> = {
  rolling_90d: '90 天滚动', since_added: '加入以来', all_time: '全历史',
};

function fmtDd(dd: { toNumber(): number; toFixed(n: number): string } | null, digits = 1): string {
  if (!dd) return '—';
  const n = dd.toNumber();
  return n >= 0 ? `-${dd.toFixed(digits)}%` : `+${Math.abs(n).toFixed(digits)}%`;
}

export default async function TokenPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string; quote?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tokenId = decodeURIComponent(id);
  const token = repo.getToken(tokenId);
  if (!token) notFound();

  const cfg = getConfig();
  const now = nowSec();
  const mode = (ATH_MODES.includes(sp.mode as AthMode) ? sp.mode : cfg.defaultRule.athMode) as AthMode;
  const quoteMode = sp.quote === 'native' ? 'native' : 'usd';
  // ATH 计算用的粒度（specFor）与图表显示用的粒度是两回事。
  // 90 天用 5m 是 17000+ 根，在 1200px 上每根 0.07px，既读不了、
  // JSON 也有 1.5MB。窗口超过 7 天一律用 1h 显示。
  const athTf = specFor(mode).timeframe;
  const windowDays =
    mode === 'rolling_90d' ? 90
    : mode === 'all_time' ? 180
    : (now - token.addedAt) / 86400;
  const tf = windowDays > 7 ? '1h' : athTf;
  // 按模式的窗口裁剪 —— all_time 之外都不该显示窗口外的数据。
  // 1h 序列覆盖 180 天，不裁的话 90 天视图会混入更早的高点，价格轴被撑坏。
  const chartFrom =
    mode === 'rolling_90d' ? now - 90 * 86400
    : mode === 'since_added' ? token.addedAt
    : 0;

  const candles = repo.getCandles(tokenId, tf, chartFrom);
  const lastRow = repo.getCandles(tokenId, '5m', 0).at(-1);
  const price = priceFromText(quoteMode === 'usd' ? lastRow?.c ?? null : lastRow?.cNative ?? null);

  const ath = repo.getAth(tokenId, mode, quoteMode);
  const athRobust = priceFromText(ath?.athRobust ?? null);
  const athRaw = priceFromText(ath?.athRaw ?? null);
  const dd = price && athRobust ? drawdownPct(athRobust, price) : null;

  // 市值回撤：只在 ATH 时刻的市值已知时才算。
  // 未知时不用价格反推 —— 那等于假设供应量不变，算出来就是价格回撤换个标签。
  const mcNow = repo.listPools(tokenId).length > 0 ? lastRow?.marketCapUsd ?? null : null;
  const mcDd = mcNow && ath?.athMarketCap && ath.athMarketCap > 0
    ? (1 - mcNow / ath.athMarketCap) * 100 : null;
  const mcGap = mcDd !== null && dd ? Math.abs(mcDd - dd.toNumber()) : null;

  const spikeGap = athRaw && athRobust && athRobust.gt(0)
    ? athRaw.minus(athRobust).div(athRobust).mul(100) : null;

  const levels = (() => {
    try { return JSON.parse(repo.getRulesFor(tokenId)[0]?.levels ?? '[]') as number[]; }
    catch { return []; }
  })();

  const priceLines: PriceLine[] = [];
  if (athRobust) {
    priceLines.push({ price: +athRobust.toString(), color: '#60a5fa', title: 'ATH(robust)' });
    for (const lv of levels) {
      priceLines.push({
        price: +athRobust.mul(100 - lv).div(100).toString(),
        color: lv >= 90 ? '#ef4444' : '#f59e0b',
        title: `-${lv}%`,
      });
    }
  }

  const alerts = repo.listAlerts(200).filter((a) => a.tokenId === tokenId);
  const markers = alerts.map((a) => ({ time: a.firedAt, text: `-${a.level}%` }));

  const pools = repo.listPools(tokenId);
  const liqTotal = pools.filter((p) => p.isOutlier === 0).reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);
  const job = repo.getBackfillJob(tokenId, athTf);

  return (
    <main className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <Nav current="/" />
      <h1 className="text-xl font-semibold mt-2">
        {token.symbol ?? token.address.slice(0, 10)}
        <span className="ml-2 text-sm font-normal text-neutral-500">{token.chain}</span>
      </h1>
      {token.note && <p className="text-sm text-amber-500/90 mt-1">{token.note}</p>}
      <p className="text-xs text-neutral-600 mt-1 break-all">{token.address}</p>

      <div className="flex flex-wrap gap-2 my-4 text-xs">
        {ATH_MODES.map((m) => (
          <Link key={m} href={`/token/${encodeURIComponent(tokenId)}?mode=${m}&quote=${quoteMode}`}
            className={`px-2 py-1 rounded ${m === mode ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-400'}`}>
            {MODE_LABEL[m]}
          </Link>
        ))}
        <span className="w-3" />
        {(['usd', 'native'] as const).map((q) => (
          <Link key={q} href={`/token/${encodeURIComponent(tokenId)}?mode=${mode}&quote=${q}`}
            className={`px-2 py-1 rounded ${q === quoteMode ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-400'}`}>
            {q === 'usd' ? 'USD' : `原生币(${cfg.chains[token.chain as keyof typeof cfg.chains]?.nativeSymbol ?? ''})`}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4 text-sm">
        <div><div className="text-xs text-neutral-500">当前价</div>
          <div className="tabular-nums">{price ? formatPrice(price, 6) : '—'}</div></div>
        <div><div className="text-xs text-neutral-500">ATH (robust)</div>
          <div className="tabular-nums">{athRobust ? formatPrice(athRobust, 6) : '—'}</div></div>
        <div><div className="text-xs text-neutral-500">ATH (raw)</div>
          <div className="tabular-nums text-neutral-400">{athRaw ? formatPrice(athRaw, 6) : '—'}</div></div>
        <div><div className="text-xs text-neutral-500">回撤</div>
          <div className={`tabular-nums font-medium ${(dd?.toNumber() ?? 0) >= 80 ? 'text-red-400' : (dd?.toNumber() ?? 0) >= 50 ? 'text-amber-400' : 'text-neutral-300'}`}>
            {fmtDd(dd)}</div></div>
        <div><div className="text-xs text-neutral-500">流动性(总)</div>
          <div className="tabular-nums">${Math.round(liqTotal).toLocaleString()}</div></div>
        <div><div className="text-xs text-neutral-500">市值回撤</div>
          <div className="tabular-nums">
            {mcDd !== null
              ? <span className={mcDd >= 80 ? 'text-red-400' : mcDd >= 50 ? 'text-amber-400' : 'text-neutral-300'}>
                  {mcDd >= 0 ? '-' : '+'}{Math.abs(mcDd).toFixed(1)}%
                </span>
              : <span className="text-neutral-600 text-xs">高点市值未记录</span>}
          </div>
          {mcDd !== null && mcGap !== null && mcGap >= 3 && (
            <div className="text-xs text-amber-500/80 mt-0.5">与价格差 {mcGap.toFixed(1)}pp，供应量有变动</div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3 text-xs">
        {ath?.athTs && (
          <span className="px-2 py-1 rounded bg-neutral-900 text-neutral-400">
            高点 {humanAgo(ath.athTs, now)} · {fmtUtc(ath.athTs)}
          </span>
        )}
        {ath?.athConfidence === 'inferred' && (
          <span className="px-2 py-1 rounded bg-neutral-900 text-neutral-500" title="高点来自回填数据，无流动性与成交笔数">
            高点为回填推断
          </span>
        )}
        {ath?.backfillPartial === 1 && (
          <span className="px-2 py-1 rounded bg-amber-950/50 text-amber-400">
            数据源历史深度不足，窗口未完整覆盖
          </span>
        )}
        {spikeGap && spikeGap.gt(20) && (
          <span className="px-2 py-1 rounded bg-amber-950/50 text-amber-400">
            该币有插针史：raw 比 robust 高 {spikeGap.toFixed(0)}%
          </span>
        )}
        {job && job.status !== 'done' && (
          <span className="px-2 py-1 rounded bg-sky-950/50 text-sky-400">
            回填中 {job.pagesDone}/{job.pagesEstimated} 页
          </span>
        )}
      </div>

      <div className="rounded border border-neutral-800 p-2 mb-6">
        <Chart tokenId={tokenId} timeframe={tf} quoteMode={quoteMode} from={chartFrom}
          priceLines={priceLines} markers={markers} />
        <div className="text-xs text-neutral-600 mt-2 px-1">
          {candles.length} 根 {tf} candle{tf !== athTf && <span>（ATH 按 {athTf} 计算，此处仅为显示）</span>} ·
          蓝线 = ATH(robust) · 橙/红线 = 各档阈值 · 箭头 = 历史报警
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <section>
          <h2 className="text-sm font-medium mb-2">池子（{pools.length}）</h2>
          <table className="w-full text-xs">
            <thead><tr className="text-neutral-500 text-left border-b border-neutral-800">
              <th className="py-1 pr-2">DEX</th><th className="py-1 pr-2">报价币</th>
              <th className="py-1 pr-2">价格</th><th className="py-1 pr-2">流动性</th><th className="py-1">标记</th>
            </tr></thead>
            <tbody>
              {pools.slice(0, 12).map((p) => (
                <tr key={p.id} className="border-b border-neutral-900">
                  <td className="py-1 pr-2">{p.dex}</td>
                  <td className="py-1 pr-2 text-neutral-400">{p.quoteSymbol}</td>
                  <td className="py-1 pr-2 tabular-nums text-neutral-400">{p.priceUsd ? (+p.priceUsd).toPrecision(5) : '—'}</td>
                  <td className="py-1 pr-2 tabular-nums">${Math.round(p.liquidityUsd ?? 0).toLocaleString()}</td>
                  <td className="py-1">
                    {p.isPrimary === 1 && <span className="text-sky-400">主池</span>}
                    {p.isOutlier === 1 && <span className="text-amber-500">价格离群·已剔除</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2 className="text-sm font-medium mb-2">报警历史（{alerts.length}）</h2>
          {alerts.length === 0 ? (
            <p className="text-xs text-neutral-600">暂无</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="text-neutral-500 text-left border-b border-neutral-800">
                <th className="py-1 pr-2">时间</th><th className="py-1 pr-2">档位</th>
                <th className="py-1 pr-2">回撤</th><th className="py-1">投递</th>
              </tr></thead>
              <tbody>
                {alerts.map((a) => {
                  let ok: boolean | null = null;
                  try {
                    const d = a.delivered ? JSON.parse(a.delivered) as Array<{ ok: boolean }> : null;
                    ok = d ? d.every((x) => x.ok) : null;
                  } catch { ok = false; }
                  return (
                    <tr key={a.id} className="border-b border-neutral-900">
                      <td className="py-1 pr-2 text-neutral-400">{fmtUtc(a.firedAt)}</td>
                      <td className="py-1 pr-2">-{a.level}%</td>
                      <td className="py-1 pr-2 tabular-nums">{a.drawdownUsd ? `-${(+a.drawdownUsd).toFixed(1)}%` : '—'}</td>
                      <td className="py-1">
                        {ok === null ? <span className="text-amber-500">未投递</span>
                          : ok ? <span className="text-neutral-500">已送达</span>
                          : <span className="text-red-400">失败</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
