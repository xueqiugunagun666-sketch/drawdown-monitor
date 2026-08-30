'use client';

import { useState } from 'react';
import { Decimal, formatPrice } from '../../lib/decimal.ts';

export interface HoldingRow {
  tokenId: string; chain: string; address: string; symbol: string | null; wallet: string;
  amount: string | null; priceUsd: string | null; valueUsd: string | null;
  monitored: boolean; filterReason: string | null; lastQuoteAt: number | null; decimalsKnown: boolean;
}

const usd = (v: string | null) => {
  if (v === null) return '—';
  const n = new Decimal(v);
  if (n.gte(1)) return `$${n.toFixed(2)}`;
  if (n.gt(0)) return `$${n.toFixed(4)}`;
  return '$0';
};

/**
 * 极小价格要截断。Decimal 全局设了 toExpNeg:-40（memecoin 价格必须展开成
 * 普通记法），但 5.47e-24 展开就是 29 个字符，会把表格撑到手机屏外。
 * 这类价格的具体数值没有阅读价值，标成"< $0.000001"就够。
 */
const price = (v: string | null) => {
  if (v === null) return '—';
  const n = new Decimal(v);
  if (n.lt('0.000001') && n.gt(0)) return '< $0.000001';
  return `$${formatPrice(n, 6)}`;
};

const amount = (v: string | null) => {
  if (v === null) return '—';
  const n = new Decimal(v);
  if (n.gte(1e9)) return `${n.div(1e9).toFixed(2)}B`;
  if (n.gte(1e6)) return `${n.div(1e6).toFixed(2)}M`;
  if (n.gte(1000)) return `${n.div(1000).toFixed(2)}K`;
  return n.toFixed(n.gte(1) ? 2 : 6);
};

function Row({ h }: { h: HoldingRow }) {
  return (
    <li className={`rounded border px-3 py-2 ${
      h.monitored ? 'border-neutral-900 bg-neutral-950/60' : 'border-neutral-900/60 bg-neutral-950/30'
    }`}>
      <div className="flex items-baseline gap-2">
        <span className={`font-medium ${h.monitored ? 'text-neutral-200' : 'text-neutral-500'}`}>
          {h.symbol ?? `${h.address?.slice(0, 8)}…`}
        </span>
        <span className="text-xs text-neutral-600">{h.chain}</span>
        <span className="text-xs text-neutral-600 truncate">{h.wallet}</span>
        <span className={`ml-auto tabular-nums shrink-0 ${
          h.monitored ? 'text-neutral-200' : 'text-neutral-500'
        }`}>
          {usd(h.valueUsd)}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-0.5 text-xs text-neutral-600">
        <span className="tabular-nums">{amount(h.amount)}</span>
        <span>@</span>
        <span className="tabular-nums">{price(h.priceUsd)}</span>
        {/* 没进监控必须说明原因，不能让币静静消失（第 4 条铁律） */}
        <span className={`ml-auto shrink-0 text-right ${h.monitored ? 'text-[#3fbf7f]' : 'text-neutral-500'}`}>
          {h.monitored ? '监控中' : h.filterReason ?? '未监控'}
        </span>
      </div>
    </li>
  );
}

export default function HoldingsTable({ holdings }: { holdings: HoldingRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const monitored = holdings.filter((h) => h.monitored);
  const filtered = holdings.filter((h) => !h.monitored);
  const total = monitored.reduce(
    (s, h) => (h.valueUsd ? s.plus(new Decimal(h.valueUsd)) : s), new Decimal(0));

  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <h2 className="text-sm text-neutral-400">持仓</h2>
        <span className="text-xs text-neutral-600">
          监控中 {monitored.length}{filtered.length > 0 && ` · 已过滤 ${filtered.length}`}
        </span>
        <span className="ml-auto text-sm text-neutral-300 tabular-nums">
          合计 {usd(total.toString())}
        </span>
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-neutral-600">
          还没扫到持仓。加了钱包后，第一次扫描要等十几分钟。
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {monitored.map((h) => <Row key={`${h.wallet}-${h.tokenId}`} h={h} />)}
            {showAll && filtered.map((h) => <Row key={`${h.wallet}-${h.tokenId}`} h={h} />)}
          </ul>
          {filtered.length > 0 && (
            <button type="button" onClick={() => setShowAll(!showAll)}
              className="mt-2 text-xs text-neutral-600 hover:text-neutral-400">
              {showAll ? '收起被过滤的' : `显示被过滤的 ${filtered.length} 个（流动性或成交量不足）`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
