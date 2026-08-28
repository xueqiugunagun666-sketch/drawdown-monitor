'use client';

import Link from 'next/link';
import Sparkline from './Sparkline.tsx';
import TokenActions from './TokenActions.tsx';
import PinButton from './PinButton.tsx';
import { severityClass, severityBar } from '../lib/severity.ts';

export interface RowData {
  id: string;
  symbol: string | null;
  chain: string;
  note: string | null;
  createdBy: string | null;
  frozen: boolean;
  enabled: boolean;
  isStale: boolean;
  pinned: boolean;
  state: string;
  price: string | null;
  dd: number | null;
  ddNative: number | null;
  athAgo: string | null;
  /** 距下一档还差多少个百分点 */
  toNext: { level: number; gap: number } | null;
  liqTotal: number;
  poolCount: number;
  outliers: number;
  primaryLabel: string | null;
  primaryShare: number;
  spark: { points: number[]; athIndex: number | null };
  modes: Array<{ label: string; value: string | null; dd: number | null; partial: boolean }>;
}

function fmtDd(v: number | null, digits = 1): string {
  if (v === null) return '—';
  return v >= 0 ? `-${v.toFixed(digits)}%` : `+${Math.abs(v).toFixed(digits)}%`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

export default function TokenRow({ r }: { r: RowData }) {
  const dim = r.frozen || !r.enabled;

  return (
    <div className={`group relative rounded-lg border transition-colors ${
      r.pinned
        ? 'border-[#fab219]/30 bg-[#fab219]/[0.04] hover:border-[#fab219]/50'
        : 'border-neutral-900 bg-neutral-950/60 hover:border-neutral-800'
    } ${dim ? 'opacity-50' : ''}`}>
      {/* 严重度色条：数字之外的第二重编码，颜色不单独承载信息 */}
      <div className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${severityBar(r.dd)}`} />

      <div className="pl-4 pr-3 py-3 grid grid-cols-12 gap-3 items-center">
        {/* 代币 */}
        <div className="col-span-12 md:col-span-3 min-w-0">
          <div className="flex items-baseline gap-2">
            <PinButton tokenId={r.id} pinned={r.pinned} />
            <Link href={`/token/${encodeURIComponent(r.id)}`}
              className="font-medium hover:text-sky-400 truncate">
              {r.symbol ?? r.id.slice(0, 10)}
            </Link>
            <span className="text-[11px] text-neutral-600 shrink-0">{r.chain}</span>
            {r.isStale && <span className="text-[11px] text-[#d03b3b] shrink-0">失联</span>}
            {r.frozen && <span className="text-[11px] text-neutral-600 shrink-0">已冻结</span>}
          </div>
          {r.note && <div className="text-xs text-amber-500/90 truncate mt-0.5">{r.note}</div>}
          {r.createdBy && <div className="text-[11px] text-neutral-700 mt-0.5">{r.createdBy}</div>}
        </div>

        {/* 回撤 —— 整行的视觉锚点 */}
        <div className="col-span-5 md:col-span-2">
          <div className={`text-2xl font-semibold tabular-nums leading-none ${severityClass(r.dd)}`}>
            {fmtDd(r.dd)}
          </div>
          <div className="text-[11px] text-neutral-600 mt-1">
            {r.athAgo ? `高点 ${r.athAgo}` : '数据不足'}
            {r.ddNative !== null && <span className="ml-2">原生 {fmtDd(r.ddNative, 0)}</span>}
          </div>
        </div>

        {/* 走势 */}
        <div className="col-span-7 md:col-span-2 flex justify-start md:justify-center">
          <Sparkline points={r.spark.points} athIndex={r.spark.athIndex} />
        </div>

        {/* 价格与流动性 */}
        <div className="col-span-6 md:col-span-2 text-sm">
          <div className="tabular-nums">{r.price ?? '—'}</div>
          <div className="text-[11px] text-neutral-600">
            {fmtUsd(r.liqTotal)} · {r.poolCount} 池
            {r.outliers > 0 && <span className="text-amber-600/80"> · 剔除 {r.outliers}</span>}
          </div>
        </div>

        {/* 距下一档 + 状态 */}
        <div className="col-span-6 md:col-span-2 text-xs">
          {r.toNext ? (
            <div className="text-neutral-400">
              还差 <span className="tabular-nums text-neutral-200">{r.toNext.gap.toFixed(1)}</span> 到 {r.toNext.level}%
            </div>
          ) : (
            <div className="text-neutral-700">已过最高档</div>
          )}
          <div className="mt-1 flex items-center gap-2">
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${
              r.state === 'FIRED' ? 'bg-[#d03b3b]/15 text-[#d03b3b]' : 'bg-neutral-900 text-neutral-500'
            }`}>{r.state}</span>
            {r.primaryLabel && (
              <span className="text-[11px] text-neutral-600 truncate">{r.primaryLabel}</span>
            )}
          </div>
          {r.primaryShare < 0.5 && (
            <div className="text-[11px] text-amber-600/80 mt-0.5">
              主池占 {(r.primaryShare * 100).toFixed(0)}%
            </div>
          )}
        </div>

        {/* 三种 ATH —— 次要信息，默认收起 */}
        <div className="col-span-12 md:col-span-1 flex md:justify-end">
          <details className="text-[11px] w-full md:w-auto">
            <summary className="cursor-pointer text-neutral-600 hover:text-neutral-400 list-none">
              三种 ATH
            </summary>
            <div className="mt-1 space-y-0.5 md:absolute md:right-3 md:mt-1 md:z-10
                            md:bg-neutral-900 md:border md:border-neutral-800 md:rounded md:p-2 md:shadow-lg">
              {r.modes.map((m) => (
                <div key={m.label} className="flex gap-2 whitespace-nowrap">
                  <span className="text-neutral-600 w-14">{m.label}</span>
                  <span className="tabular-nums text-neutral-400">{m.value ?? '—'}</span>
                  <span className={`tabular-nums ${severityClass(m.dd)}`}>{fmtDd(m.dd, 0)}</span>
                  {m.partial && <span className="text-amber-600/80">不完整</span>}
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>

      {/* 操作：hover 才出现，平时不占视觉 */}
      <div className="px-4 pb-2 -mt-1 opacity-0 group-hover:opacity-100 transition-opacity
                      focus-within:opacity-100">
        <TokenActions tokenId={r.id} symbol={r.symbol} note={r.note}
          frozen={r.frozen} enabled={r.enabled} />
      </div>
    </div>
  );
}
