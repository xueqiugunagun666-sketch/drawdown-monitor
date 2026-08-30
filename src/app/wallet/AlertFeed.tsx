'use client';

import { Decimal, formatPrice } from '../../lib/decimal.ts';
import { pumpClass, pumpBar, describeBasis } from '../../lib/pumpStyle.ts';
import { humanAgo } from '../../lib/time.ts';

export interface AlertRow {
  id: string; tokenId: string; firedAt: number; timeframe: string; basis: string;
  level: number; multiple: string; priceUsd: string | null; basePriceUsd: string | null;
  valueUsd: string | null;
  symbol: string | null; address: string | null; chain: string | null;
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
  const a = alerts[0];
  // 超过一小时的就不算"刚刚"了，别一直挂着
  if (!a || Math.floor(Date.now() / 1000) - a.firedAt > 3600) return null;

  return (
    <button type="button" onClick={() => onFocus?.(a.tokenId)}
      className="w-full text-left rounded border border-[#3fbf7f]/50 bg-[#3fbf7f]/10
                 px-3 py-2.5 hover:bg-[#3fbf7f]/15 transition-colors">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[#3fbf7f] text-lg font-medium">{alertName(a)}</span>
        <span className={`${pumpClass(a.level)} text-lg font-medium tabular-nums`}>
          {new Decimal(a.multiple).toFixed(1)}x
        </span>
        <span className="text-sm text-neutral-400">{describeBasis(a.timeframe, a.basis)}</span>
        <span className="ml-auto text-xs text-neutral-500">{humanAgo(a.firedAt)}</span>
      </div>
      {a.basePriceUsd && a.priceUsd && (
        <div className="text-xs text-neutral-500 tabular-nums mt-0.5">
          ${formatPrice(new Decimal(a.basePriceUsd), 6)} → ${formatPrice(new Decimal(a.priceUsd), 6)}
          {a.chain && <span className="ml-2">{a.chain}</span>}
        </div>
      )}
    </button>
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
