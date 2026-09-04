'use client';

import { useState } from 'react';
import { copyText } from '../../lib/copy.ts';

import { Decimal, formatPrice } from '../../lib/decimal.ts';
import { pumpClass, pumpBar, describeBasis } from '../../lib/pumpStyle.ts';
import { humanAgo } from '../../lib/time.ts';

export interface AlertRow {
  id: string; tokenId: string; firedAt: number; timeframe: string; basis: string;
  level: number; multiple: string; priceUsd: string | null; basePriceUsd: string | null;
  valueUsd: string | null;
  symbol: string | null; address: string | null; chain: string | null;
  /** 投递序号。只有 SSE 推来的带，/api/wallet/alerts 的历史列表没有 */
  seq?: number;
  /** 'level' 穿档 | 'advance' 未升档但又涨了一截。旧行是 null，按穿档读 */
  kind?: string | null;
}

/** 币名优先，没有才退回地址 —— 显示一串十六进制等于没说 */
export function alertName(a: AlertRow): string {
  if (a.symbol) return a.symbol;
  const addr = a.address ?? a.tokenId.split(':')[1] ?? '';
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '未知代币';
}

/**
 * 最新一条报警的横幅，放在页面最顶上。
 *
 * 用户听到语音播报后打开页面，第一眼必须看到"是哪个币"。
 * 把这件事埋在页面底部的列表里等于没做 —— 实际反馈就是
 * "收到播报去看，根本不知道哪一个暴涨了"。
 */
export function LatestAlertBanner(
  { alerts, onFocus }: { alerts: AlertRow[]; onFocus?: (tokenId: string) => void },
) {
  const [copied, setCopied] = useState<boolean | 'selected'>(false);
  const a = alerts[0];
  // 超过一小时的就不算"刚刚"了，别一直挂着
  if (!a || Math.floor(Date.now() / 1000) - a.firedAt > 3600) return null;

  const addr = a.address ?? a.tokenId.split(':')[1] ?? '';

  async function copy() {
    if (!addr) return;
    const ok = await copyText(addr, 'alert-ca');
    // 失败时也给反馈：文本已被选中，提示用户自己复制
    setCopied(ok ? true : 'selected');
    setTimeout(() => setCopied(false), 2200);
  }

  return (
    // 外层不能再是 button —— 里面要放复制按钮，button 不能嵌 button
    <div className="rounded-lg border border-[#3fbf7f]/50 bg-[#3fbf7f]/10 px-3 py-2.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <button type="button" onClick={() => onFocus?.(a.tokenId)}
          className="text-[#3fbf7f] text-lg font-medium hover:underline underline-offset-4
                     focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#3fbf7f] rounded">
          {alertName(a)}
        </button>
        <span className={`${pumpClass(a.level)} text-lg font-medium tabular-nums`}>
          {new Decimal(a.multiple).toFixed(1)}x
        </span>
        <span className="text-sm text-neutral-400">{describeBasis(a.timeframe, a.basis)}</span>
        <span className="ml-auto text-xs text-neutral-500 shrink-0">{humanAgo(a.firedAt)}</span>
      </div>

      {a.basePriceUsd && a.priceUsd && (
        <div className="text-xs text-neutral-500 tabular-nums mt-1">
          ${formatPrice(new Decimal(a.basePriceUsd), 6)} → ${formatPrice(new Decimal(a.priceUsd), 6)}
          {a.chain && <span className="ml-2">{a.chain}</span>}
        </div>
      )}

      {addr && (
        <div className="flex items-center gap-2 mt-2">
          {/* 合约地址完整放在这里，一键复制 —— 收到报警后第一件事
              多半是拿 CA 去交易所或行情站查 */}
          <code id="alert-ca" className="text-[11px] font-mono text-neutral-500 truncate">
            {addr}
          </code>
          <button type="button" onClick={() => void copy()}
            className={`shrink-0 text-xs px-2 py-1 rounded border transition-colors whitespace-nowrap ${
              copied === true ? 'border-[#3fbf7f]/50 bg-[#3fbf7f]/15 text-[#3fbf7f]'
              : copied === 'selected' ? 'border-[#fab219]/50 bg-[#fab219]/10 text-[#fab219]'
              : 'border-neutral-700 bg-neutral-900/60 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600'
            }`}>
            {copied === true ? '已复制' : copied === 'selected' ? '已选中，请手动复制' : '复制 CA'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AlertFeed({ alerts }: { alerts: AlertRow[] }) {
  return (
    <section>
      <h2 className="text-sm text-neutral-400 mb-2">异动记录</h2>
      {alerts.length === 0 ? (
        <p className="text-sm text-neutral-600">还没有异动。有币暴涨到 2 倍时会响。</p>
      ) : (
        <ul className="space-y-1.5">
          {alerts.map((a) => (
            <li key={a.id}
              className="relative flex items-center gap-3 rounded-lg surface-interactive
                         pl-4 pr-3 py-2.5 text-sm overflow-hidden">
              <span className={`absolute left-0 top-0 bottom-0 w-1 ${pumpBar(a.level)}`} />
              {/* 倍数用数字承载信息，颜色只是冗余强化 */}
              <span className={`${pumpClass(a.level)} tabular-nums font-medium w-16 shrink-0`}>
                {new Decimal(a.multiple).toFixed(1)}x
              </span>
              <span className="text-[15px] text-neutral-200 shrink-0 font-medium">{alertName(a)}</span>
              <span className="text-neutral-500 text-xs shrink-0">
                {describeBasis(a.timeframe, a.basis)}
              </span>
              {a.basePriceUsd && a.priceUsd && (
                <span className="text-neutral-600 text-xs tabular-nums hidden sm:inline">
                  ${formatPrice(new Decimal(a.basePriceUsd), 6)} → ${formatPrice(new Decimal(a.priceUsd), 6)}
                </span>
              )}
              <span className="ml-auto text-xs text-neutral-600 shrink-0">{humanAgo(a.firedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
