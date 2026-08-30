'use client';

import { Decimal, formatPrice } from '../../lib/decimal.ts';
import { pumpClass, pumpBar, describeBasis } from '../../lib/pumpStyle.ts';
import { humanAgo } from '../../lib/time.ts';

export interface AlertRow {
  id: string; tokenId: string; firedAt: number; timeframe: string; basis: string;
  level: number; multiple: string; priceUsd: string | null; basePriceUsd: string | null;
  valueUsd: string | null;
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
              className="relative flex items-center gap-3 rounded border border-neutral-900
                         bg-neutral-950/60 pl-4 pr-3 py-2 text-sm overflow-hidden">
              <span className={`absolute left-0 top-0 bottom-0 w-1 ${pumpBar(a.level)}`} />
              {/* 倍数用数字承载信息，颜色只是冗余强化 */}
              <span className={`${pumpClass(a.level)} tabular-nums font-medium w-16 shrink-0`}>
                {new Decimal(a.multiple).toFixed(1)}x
              </span>
              <span className="text-neutral-200 shrink-0">
                {a.tokenId.split(':')[1]?.slice(0, 10)}…
              </span>
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
