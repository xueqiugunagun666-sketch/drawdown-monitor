'use client';

import { useEffect, useState } from 'react';
import { copyText } from '../../lib/copy.ts';
import TokenLinks from '../../components/TokenLinks.tsx';
import { humanAgo } from '../../lib/time.ts';
import {
  matchesFilter, isDefault, loadFilter, saveFilter, DEFAULT_FILTER,
  UPSTREAM_MIN_DRAWDOWN, UPSTREAM_MIN_PEAK, type TrashFilter,
} from './filters.ts';

export interface SignalSource {
  callerName: string | null;
  groupName: string | null;
  firstCallTime: number | null;
}

export interface SignalRow {
  id: number;
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  peakMarketCap: number | null;
  currentMarketCap: number | null;
  drawdownPercent: number | null;
  firstCallTime: number | null;
  triggeredAt: number | null;
  sources: string | null;      // JSON
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  telegramUrl?: string | null;
}

/**
 * 市值。用 K / M 而不是千位分隔符 —— 这一栏的数字是拿来**互相比较**的
 * （峰值 vs 现值），量级比精确到分更重要。
 */
export function money(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * 跌幅显示。**截断而不是四舍五入**。
 *
 * 四舍五入会让 80.95% 显示成 81.0%，而筛选按真值判 —— 用户填「跌幅 ≥81」
 * 看到一条写着 81.0% 的被筛掉了，只会觉得是筛错了。显示的数永远不夸大，
 * 显示与筛选才对得上。
 */
export function drawdownText(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `-${(Math.floor(v * 10) / 10).toFixed(1)}%`;
}

export function parseSources(raw: string | null): SignalSource[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v as SignalSource[] : [];
  } catch {
    return [];                 // 存坏了不能让整页白屏
  }
}

/** 喊单的群。同一个币可能好几个群都喊过，全列出来 —— 那本身就是信息 */
function groupsOf(row: SignalRow): string[] {
  const seen = new Set<string>();
  for (const s of parseSources(row.sources)) {
    const g = s.groupName?.trim();
    if (g) seen.add(g);
  }
  return [...seen];
}

function Row({ r }: { r: SignalRow }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'selected'>('idle');
  const id = `trash-ca-${r.id}`;
  const groups = groupsOf(r);
  const callers = parseSources(r.sources).map((s) => s.callerName).filter(Boolean);

  return (
    <li className="rounded-lg surface-interactive px-3 py-2.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[15px] font-medium text-neutral-200">{r.symbol ?? r.name ?? '未知代币'}</span>
        <span className="meta-label">{r.chain}</span>
        {/* 同名假币很多，最终认的是 CA */}
        <button type="button" title={r.address}
          onClick={async () => {
            setCopied(await copyText(r.address, id) ? 'ok' : 'selected');
            setTimeout(() => setCopied('idle'), 1600);
          }}
          className={`text-xs font-mono truncate transition-colors ${
            copied === 'ok' ? 'text-[#3fbf7f]'
            : copied === 'selected' ? 'text-[#fab219]'
            : 'text-neutral-600 hover:text-neutral-400'
          }`}>
          <span id={id}>{`${r.address.slice(0, 6)}…${r.address.slice(-4)}`}</span>
          {copied === 'ok' && <span className="ml-1">已复制</span>}
          {copied === 'selected' && <span className="ml-1">已选中</span>}
        </button>
        <TokenLinks chain={r.chain} address={r.address}
          websiteUrl={r.websiteUrl} twitterUrl={r.twitterUrl} telegramUrl={r.telegramUrl} />
        <span className="ml-auto shrink-0 tabular-nums text-[15px] text-[#d03b3b]">
          {drawdownText(r.drawdownPercent)}
        </span>
      </div>

      <div className="flex items-baseline gap-2 mt-1 text-xs text-neutral-500 flex-wrap">
        <span className="tabular-nums">
          峰值 <span className="text-neutral-300">{money(r.peakMarketCap)}</span>
        </span>
        <span className="text-neutral-700">→</span>
        {/* 不能写「现在」：游标越过这条之后就不会再重拉，这个数字冻结在抓取那一刻。
            对几天前的信号来说「现在」是假的，而它正是跌幅对应的那个数 */}
        <span className="tabular-nums">
          触发时 <span className="text-neutral-300">{money(r.currentMarketCap)}</span>
        </span>
        {groups.length > 0 && (
          <span className="text-neutral-400 truncate">
            {groups.join(' · ')}
            {callers.length > 0 && <span className="text-neutral-600">（{callers.join('、')}）</span>}
          </span>
        )}
        <span className="ml-auto shrink-0 text-neutral-600">
          {r.triggeredAt ? humanAgo(r.triggeredAt) : '时间未知'}
        </span>
      </div>
    </li>
  );
}

/**
 * 列表。服务端先渲染一份，客户端每分钟刷一次 ——
 * worker 也是 60 秒一轮，刷更勤没有新东西可拿。
 */
const DAY_CHOICES: Array<[label: string, days: number | null]> = [
  ['1 天', 1], ['3 天', 3], ['7 天', 7], ['30 天', 30], ['全部', null],
];

function FilterBar(
  { f, onChange, total, shown }:
  { f: TrashFilter; onChange: (f: TrashFilter) => void; total: number; shown: number },
) {
  const input = 'w-20 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 '
    + 'text-xs text-neutral-200 tabular-nums outline-none focus:border-neutral-600';
  return (
    <div className="flex items-center gap-x-4 gap-y-2 flex-wrap mb-3 text-xs">
      <div className="flex items-center gap-1">
        {DAY_CHOICES.map(([label, days]) => (
          <button key={label} type="button" onClick={() => onChange({ ...f, days })}
            className={`px-2 py-1 rounded ${
              f.days === days ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
            }`}>
            {label}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-1.5 text-neutral-500">
        跌幅 ≥
        <input value={f.minDrawdown} inputMode="decimal" aria-label="最小跌幅（%）"
          onChange={(e) => onChange({ ...f, minDrawdown: Number(e.target.value) || 0 })}
          className={input} />
        %
      </label>

      <label className="flex items-center gap-1.5 text-neutral-500">
        峰值 ≥ $
        <input value={f.minPeak / 10_000} inputMode="decimal" aria-label="最小峰值市值（万美元）"
          onChange={(e) => onChange({ ...f, minPeak: (Number(e.target.value) || 0) * 10_000 })}
          className={input} />
        万
      </label>

      {/* 上游写死 80% / 100 万，填更松的数没有意义 —— 那种信号压根不会产出。
          不说清楚的话，用户会以为是我们漏了 */}
      {(f.minDrawdown < UPSTREAM_MIN_DRAWDOWN || f.minPeak < UPSTREAM_MIN_PEAK) && (
        <span className="text-[#fab219]">
          信号源只产出跌幅 ≥{UPSTREAM_MIN_DRAWDOWN}%、峰值 &gt;100 万的，填更松的数不会多出东西
        </span>
      )}

      <span className="ml-auto text-neutral-600 shrink-0">
        {isDefault(f) ? `存档 ${total} 条` : `${shown} / 存档 ${total} 条`}
        {!isDefault(f) && (
          <button type="button" onClick={() => onChange(DEFAULT_FILTER)}
            className="ml-2 text-neutral-500 hover:text-neutral-300 underline underline-offset-2">
            重置
          </button>
        )}
      </span>
    </div>
  );
}

export default function TrashList({ initial }: { initial: SignalRow[] }) {
  const [rows, setRows] = useState<SignalRow[]>(initial);
  /**
   * 先用默认值渲染，挂载后再读本地存的 —— 服务端渲染时没有 localStorage，
   * 直接读会让首屏与客户端对不上（hydration 报错）
   */
  const [filter, setFilter] = useState<TrashFilter>(DEFAULT_FILTER);
  useEffect(() => { setFilter(loadFilter()); }, []);

  const apply = (f: TrashFilter) => { setFilter(f); saveFilter(f); };

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/api/trash');
        if (!r.ok) return;
        const j = await r.json() as { signals?: SignalRow[] };
        if (j.signals) setRows(j.signals);
      } catch { /* 网络抖动，下一轮再说 */ }
    };
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        还没有信号。群里喊过的币，峰值市值超过 100 万、又从峰值跌掉 80% 以上时会出现在这里。
      </p>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const shown = rows.filter((r) => matchesFilter(r, filter, now));

  return (
    <>
      <FilterBar f={filter} onChange={apply} total={rows.length} shown={shown.length} />
      {shown.length === 0 ? (
        // 空结果要说明是被筛掉的，否则和"本来就没有"分不清
        <p className="text-sm text-neutral-600">
          这些条件下没有信号。存档里有 {rows.length} 条，放宽条件看看。
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((r) => <Row key={r.id} r={r} />)}
        </ul>
      )}
    </>
  );
}
