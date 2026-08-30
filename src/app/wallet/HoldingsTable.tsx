'use client';

import { useState } from 'react';
import { formatPrice } from '../../lib/decimal.ts';
import { Decimal } from '../../lib/decimal.ts';

export interface HoldingRow {
  tokenId: string; chain: string; address: string; symbol: string | null; wallet: string;
  amount: string | null; priceUsd: string | null; valueUsd: string | null;
  monitored: boolean; filterReason: string | null; lastQuoteAt: number | null; decimalsKnown: boolean;
}

const usd = (v: string | null) => {
  if (v === null) return '—';
  const n = new Decimal(v);
  // 价值用于比较大小，不参与阈值判定，展示成两位小数够了
  return `$${n.gte(1) ? n.toFixed(2) : n.toFixed(4)}`;
};

const shortAmount = (v: string | null) => {
  if (v === null) return '—';
  const n = new Decimal(v);
  if (n.gte(1e6)) return `${n.div(1e6).toFixed(2)}M`;
  if (n.gte(1000)) return `${n.div(1000).toFixed(2)}K`;
  return n.toFixed(n.gte(1) ? 2 : 6);
};

export default function HoldingsTable({ holdings }: { holdings: HoldingRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const monitored = holdings.filter((h) => h.monitored);
  const filtered = holdings.filter((h) => !h.monitored);
  const rows = showAll ? [...monitored, ...filtered] : monitored;

  const total = monitored.reduce(
    (s, h) => (h.valueUsd ? s.plus(new Decimal(h.valueUsd)) : s), new Decimal(0));

  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <h2 className="text-sm text-neutral-400">持仓</h2>
        <span className="text-xs text-neutral-600">
          监控中 {monitored.length}
          {filtered.length > 0 && ` · 已过滤 ${filtered.length}`}
        </span>
        <span className="ml-auto text-sm text-neutral-300">合计 {usd(total.toString())}</span>
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-neutral-600">
          还没扫到持仓。加了钱包后，第一次扫描要等十几分钟。
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-neutral-600 text-left">
                  <th className="font-normal py-1.5 pr-3">代币</th>
                  <th className="font-normal py-1.5 pr-3">钱包</th>
                  <th className="font-normal py-1.5 pr-3 text-right">数量</th>
                  <th className="font-normal py-1.5 pr-3 text-right">价格</th>
                  <th className="font-normal py-1.5 pr-3 text-right">价值</th>
                  <th className="font-normal py-1.5">状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={`${h.wallet}-${h.tokenId}`}
                    className={`border-t border-neutral-900 ${h.monitored ? '' : 'opacity-50'}`}>
                    <td className="py-1.5 pr-3">
                      <span className="text-neutral-200">{h.symbol ?? h.address?.slice(0, 8)}</span>
                      <span className="text-neutral-600 text-xs ml-1.5">{h.chain}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-neutral-500 text-xs">{h.wallet}</td>
                    <td className="py-1.5 pr-3 text-right text-neutral-300 tabular-nums">
                      {shortAmount(h.amount)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-neutral-400 tabular-nums">
                      {h.priceUsd ? `$${formatPrice(new Decimal(h.priceUsd), 6)}` : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-neutral-200 tabular-nums">
                      {usd(h.valueUsd)}
                    </td>
                    <td className="py-1.5 text-xs">
                      {h.monitored
                        ? <span className="text-[#3fbf7f]">监控中</span>
                        // 没进监控必须说明原因，不能让币静静消失（第 4 条铁律）
                        : <span className="text-neutral-500">{h.filterReason ?? '未监控'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length > 0 && (
            <button type="button" onClick={() => setShowAll(!showAll)}
              className="mt-2 text-xs text-neutral-600 hover:text-neutral-400">
              {showAll ? '只看监控中的' : `显示被过滤的 ${filtered.length} 个（流动性或成交量不足）`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
