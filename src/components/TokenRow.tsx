'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Sparkline from './Sparkline.tsx';
import TokenActions from './TokenActions.tsx';
import PinButton from './PinButton.tsx';
import { copyText, selectElement } from '../lib/copy.ts';
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
  canDelete: boolean;
  canEditMeta: boolean;
  canToggleGlobal: boolean;
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

/**
 * 代币名，点一下复制合约地址。
 *
 * 看完一行之后最常做的下一件事就是拿 CA 去交易所或行情站，
 * 而同名假币很多，最终认的是 CA。详情页改由整行承载 ——
 * 行内任意空白处点进去。
 */
function CopyName({ tokenId, symbol }: { tokenId: string; symbol: string | null }) {
  const [state, setState] = useState<'idle' | 'ok' | 'selected'>('idle');
  const revealRef = useRef<HTMLElement | null>(null);
  const address = tokenId.split(':')[1] ?? '';   // id 的形状是 "{chain}:{address}"
  const label = symbol ?? tokenId.slice(0, 10);

  // 复制失败时把完整地址显示出来并选中，用户长按或 Ctrl+C 仍能拿到。
  // 放在 effect 里而不是 setTimeout：元素是这次渲染才出现的，
  // 靠定时器去猜提交时机会抢在它之前，然后静默什么也不做
  useEffect(() => {
    if (state === 'selected' && revealRef.current) selectElement(revealRef.current);
  }, [state]);

  // 没有地址就没有可复制的东西。保持成普通文本，
  // 而不是给一个点下去毫无反应的按钮 —— 静默失效比不提供更糟
  if (!address) {
    return <span className="relative z-10 text-[15px] font-medium truncate">{label}</span>;
  }

  async function copy() {
    const ok = await copyText(address);
    setState(ok ? 'ok' : 'selected');
    // 失败的那份要留久一点，用户得有时间自己选中复制
    setTimeout(() => setState('idle'), ok ? 1800 : 8000);
  }

  return (
    <>
      <button type="button" onClick={() => void copy()}
        title={`点击复制合约地址\n${address}`}
        className={`relative z-10 text-[15px] font-medium truncate transition-colors
                    underline-offset-4 hover:underline hover:decoration-dotted ${
          state === 'ok' ? 'text-[#3fbf7f]'
          : state === 'selected' ? 'text-[#fab219]'
          : 'hover:text-sky-400'
        }`}>
        {label}
      </button>
      {state === 'ok' && (
        <span className="relative z-10 text-[11px] text-[#3fbf7f] shrink-0">已复制</span>
      )}
      {state === 'selected' && (
        // basis-full 另起一行；order-last 让它排到最后 ——
        // 否则它会把后面的链徽标、失联/冻结徽标一起挤到下一行去
        <code ref={revealRef}
          className="relative z-10 order-last basis-full text-[11px] font-mono text-[#fab219] break-all">
          {address}
        </code>
      )}
    </>
  );
}

export default function TokenRow({ r }: { r: RowData }) {
  const dim = r.frozen || !r.enabled;

  return (
    <div className={`group relative rounded-lg border transition-colors overflow-hidden ${
      r.pinned
        // 置顶用**亮度**而非色相：色相位已被严重度(黄/红)与走势线(蓝)占满，
        // 再塞一个色进去要么撞色、要么被误读成数据状态。
        // 提亮表面 + 亮中性边框，是深色界面上最不含糊的「这行被标记了」。
        // 用实色而非半透明：半透明叠在近黑底(rgb 10)上会被吃掉大半，
        // neutral-800/50 合成后只有 rgb 24，与底色对比度仅 1.15:1，读不出来。
        // #333 合成后约 1.6:1，配上亮边框才是清晰的「已标记」。
        ? 'border-neutral-500 bg-[#333333]'
        : 'surface-interactive'
    } ${dim ? 'opacity-50' : ''}`}>
      {/* 左缘：置顶时让位给置顶标识。
          严重度本来就由数字颜色表达了，这条色带是重复编码，
          让给二元的「是否置顶」是更好的用途 —— 边缘标记天生适合二元状态。 */}
      {r.pinned
        ? <div className="absolute left-0 top-0 bottom-0 w-1 bg-neutral-100" />
        : <div className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${severityBar(r.dd)}`} />}

      {/* 整行都是通往详情页的入口 —— 代币名让给了「复制 CA」。
          用真的 <a> 铺满整行，而不是给容器挂 onClick：
          cmd+点击开新标签、中键、右键「在新标签页打开」都得能用。
          绝对定位元素在命中测试里压在普通内容之上，所以行内每个
          可交互元素都要 relative z-10 抬上来，否则点击会被这一层吃掉。 */}
      <Link href={`/token/${encodeURIComponent(r.id)}`}
        aria-label={`${r.symbol ?? r.id} 详情`}
        className="absolute inset-0" />

      <div className="pl-4 pr-3 py-3 grid grid-cols-12 gap-3 items-center">
        {/* 代币 */}
        <div className="col-span-12 md:col-span-3 min-w-0">
          {/* flex-wrap 是给复制失败时露出的完整地址留的换行位 */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="relative z-10 flex shrink-0">
              <PinButton tokenId={r.id} pinned={r.pinned} />
            </span>
            <CopyName tokenId={r.id} symbol={r.symbol} />
            <span className="meta-label shrink-0">{r.chain}</span>
            {r.isStale && <span className="badge-fired shrink-0">失联</span>}
            {r.frozen && <span className="badge-quiet shrink-0">已冻结</span>}
          </div>
          {/* 备注原本用琥珀色，和「回撤警告」是同一个颜色，两件事抢同一个信号。
              改成中性灰：它是说明性文字，不该有告警的分量 */}
          {r.note && <div className="text-xs text-neutral-500 truncate mt-1">{r.note}</div>}
          {r.createdBy && <div className="text-[11px] text-neutral-700 mt-0.5">{r.createdBy}</div>}
        </div>

        {/* 回撤 —— 整行的视觉锚点 */}
        <div className="col-span-5 md:col-span-2">
          <div className={`text-[28px] font-semibold tabular-nums leading-none tracking-tight ${severityClass(r.dd)}`}>
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
            <span className={r.state === 'FIRED' ? 'badge-fired' : 'badge-quiet'}>{r.state}</span>
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
          <details className="relative z-10 text-[11px] w-full md:w-auto">
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

      {/* 操作：hover 才出现，平时不占视觉。
          pointer-events-none 是必须的 —— opacity-0 的按钮照样能点，
          手机上没有 hover，这一条隐形的「冻结/停用/删除」就横在整行下沿，
          现在整行都能点进详情页，误触的代价更大了。
          键盘 Tab 不受 pointer-events 影响，focus-within 仍能把它唤出来。 */}
      <div className="relative z-10 px-4 pb-2 -mt-1 opacity-0 pointer-events-none
                      group-hover:opacity-100 group-hover:pointer-events-auto
                      focus-within:opacity-100 focus-within:pointer-events-auto
                      transition-opacity">
        <TokenActions tokenId={r.id} symbol={r.symbol} note={r.note}
          frozen={r.frozen} enabled={r.enabled}
          canDelete={r.canDelete} canEditMeta={r.canEditMeta} canToggleGlobal={r.canToggleGlobal} />
      </div>
    </div>
  );
}
