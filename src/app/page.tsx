import Link from 'next/link';
import Nav from '../components/Nav.tsx';
import TokenRow, { type RowData } from '../components/TokenRow.tsx';
import { getConfig } from '../lib/config.ts';
import { priceFromText, drawdownPct, formatPrice } from '../lib/decimal.ts';
import { nowSec, humanAgo } from '../lib/time.ts';
import { ATH_MODES, ROLLING_WINDOW_SECONDS, type AthMode } from '../worker/athModes.ts';
import { backfillProgress } from '../worker/backfill.ts';
import * as repo from '../db/repo.ts';

export const dynamic = 'force-dynamic';

const MODE_LABEL: Record<AthMode, string> = {
  rolling_90d: '90 天', since_added: '加入以来', all_time: '全历史',
};

export default function Home() {
  const cfg = getConfig();
  const tokens = repo.listAllTokens();
  const lastRun = repo.getLastPollRun();
  const bf = backfillProgress();
  const now = nowSec();
  const staleCutoff = now - cfg.polling.staleMinutes * 60;
  const activeMode = (cfg.defaultRule.athMode ?? 'rolling_90d') as AthMode;
  const levels = [...cfg.defaultRule.levels].sort((a, b) => a - b);

  const rows: RowData[] = tokens.map((t) => {
    const candles = repo.getCandles(t.id, '5m', 0);
    const last = candles.at(-1);
    const price = priceFromText(last?.c ?? null);
    const priceNative = priceFromText(last?.cNative ?? null);

    const modes = ATH_MODES.map((mode) => {
      const a = repo.getAth(t.id, mode, 'usd');
      const robust = priceFromText(a?.athRobust ?? null);
      const dd = price && robust ? drawdownPct(robust, price) : null;
      return {
        mode, ath: a, robust,
        label: MODE_LABEL[mode],
        value: robust ? formatPrice(robust, 5) : null,
        dd: dd?.toNumber() ?? null,
        partial: a?.backfillPartial === 1,
      };
    });
    const active = modes.find((m) => m.mode === activeMode)!;
    const ddNum = active.dd;

    const athNative = priceFromText(repo.getAth(t.id, activeMode, 'native')?.athRobust ?? null);
    const ddNative = priceNative && athNative ? drawdownPct(athNative, priceNative) : null;

    const pools = repo.listPools(t.id);
    const primary = pools.find((p) => p.isPrimary === 1);
    const clean = pools.filter((p) => p.isOutlier === 0);
    const liqTotal = clean.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0);

    const nextLevel = ddNum === null ? null : levels.find((l) => l > ddNum);
    const sinceTs = activeMode === 'since_added' ? t.addedAt : now - ROLLING_WINDOW_SECONDS;

    return {
      id: t.id, symbol: t.symbol, chain: t.chain, note: t.note, createdBy: t.createdBy,
      frozen: t.frozen === 1, enabled: t.enabled === 1,
      isStale: t.enabled === 1 && t.frozen === 0 && (t.lastQuoteAt === null || t.lastQuoteAt < staleCutoff),
      state: repo.getAlertState(t.id, 'default', levels[0] ?? 80).state,
      price: price ? `$${formatPrice(price, 6)}` : null,
      dd: ddNum,
      ddNative: ddNative?.toNumber() ?? null,
      athAgo: active.ath?.athTs ? humanAgo(active.ath.athTs, now) : null,
      toNext: nextLevel !== undefined && nextLevel !== null && ddNum !== null
        ? { level: nextLevel, gap: nextLevel - ddNum } : null,
      liqTotal, poolCount: pools.length,
      outliers: pools.filter((p) => p.isOutlier === 1).length,
      primaryLabel: primary ? `${primary.dex ?? ''}/${primary.quoteSymbol ?? ''}` : null,
      primaryShare: primary && liqTotal > 0 ? (primary.liquidityUsd ?? 0) / liqTotal : 1,
      spark: repo.sparklinePoints(t.id, sinceTs),
      modes: modes.map((m) => ({ label: m.label, value: m.value, dd: m.dd, partial: m.partial })),
    };
  }).sort((a, b) => (b.dd ?? -1) - (a.dd ?? -1));

  const staleCount = rows.filter((r) => r.isStale).length;
  const firedCount = rows.filter((r) => r.state === 'FIRED').length;

  const stat = (label: string, value: string, tone = '') => (
    <div className="px-2 md:px-3 py-2 rounded-lg bg-neutral-900/60 border border-neutral-900">
      <div className="text-[10px] md:text-[11px] text-neutral-500 whitespace-nowrap">{label}</div>
      <div className={`text-xs md:text-sm font-medium tabular-nums mt-0.5 whitespace-nowrap ${tone}`}>{value}</div>
    </div>
  );

  return (
    <main className="p-4 md:p-8 max-w-[1500px] mx-auto">
      <Nav current="/" />

      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">回撤监控</h1>
          <p className="text-xs text-neutral-500 mt-1">
            {MODE_LABEL[activeMode]} · {cfg.defaultRule.quoteMode.toUpperCase()} 计价 ·
            档位 {levels.join(' / ')}% · k={cfg.defaultRule.athSustainCandles}
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2 w-full md:w-auto">
          {stat('清单', String(tokens.length))}
          {stat('已触发', String(firedCount), firedCount > 0 ? 'text-[#d03b3b]' : '')}
          {stat('失联', String(staleCount), staleCount > 0 ? 'text-[#d03b3b]' : '')}
          {stat('上次轮询', lastRun?.finishedAt ? humanAgo(lastRun.finishedAt, now) : '未运行')}
        </div>
      </div>

      {bf.jobs > 0 && bf.done < bf.jobs && (
        <div className="mb-3 rounded-lg border border-sky-950 bg-sky-950/20 px-3 py-2">
          <div className="flex justify-between text-xs text-sky-300/90 mb-1.5">
            <span>历史回填中 {bf.pct}% · {bf.done}/{bf.jobs} 任务</span>
            <span className="text-sky-400/60">约还需 {bf.etaMinutes} 分钟</span>
          </div>
          <div className="h-1 bg-sky-950/60 rounded-full overflow-hidden">
            <div className="h-full bg-sky-500 rounded-full transition-all" style={{ width: `${bf.pct}%` }} />
          </div>
        </div>
      )}

      {staleCount > 0 && (
        <div className="mb-3 rounded-lg border border-[#d03b3b]/30 bg-[#d03b3b]/10 px-3 py-2 text-sm text-[#d03b3b]">
          {staleCount} 个代币超过 {cfg.polling.staleMinutes} 分钟无有效报价 —— 数据源可能失联
        </div>
      )}
      {lastRun?.errors && (
        <div className="mb-3 rounded-lg border border-amber-950 bg-amber-950/20 px-3 py-2 text-xs text-amber-400/90">
          <div className="font-medium mb-1">上轮错误</div>
          {(JSON.parse(lastRun.errors) as string[]).map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {tokens.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 p-10 text-center">
          <p className="text-sm text-neutral-500">清单为空</p>
          <Link href="/add" className="inline-block mt-2 text-sm text-sky-400 hover:underline">去加币 →</Link>
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => <TokenRow key={r.id} r={r} />)}
        </div>
      )}
    </main>
  );
}
