'use client';

import { useEffect, useState } from 'react';
import { copyText } from '../../lib/copy.ts';
import { humanAgo } from '../../lib/time.ts';

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
        <span className="ml-auto shrink-0 tabular-nums text-[15px] text-[#d03b3b]">
          {r.drawdownPercent === null ? '—' : `-${r.drawdownPercent.toFixed(1)}%`}
        </span>
      </div>

      <div className="flex items-baseline gap-2 mt-1 text-xs text-neutral-500 flex-wrap">
        <span className="tabular-nums">
          峰值 <span className="text-neutral-300">{money(r.peakMarketCap)}</span>
        </span>
        <span className="text-neutral-700">→</span>
        <span className="tabular-nums">
          现在 <span className="text-neutral-300">{money(r.currentMarketCap)}</span>
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
export default function TrashList({ initial }: { initial: SignalRow[] }) {
  const [rows, setRows] = useState<SignalRow[]>(initial);

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

  return (
    <>
      <p className="text-xs text-neutral-600 mb-2">共 {rows.length} 个</p>
      <ul className="space-y-1.5">
        {rows.map((r) => <Row key={r.id} r={r} />)}
      </ul>
    </>
  );
}
