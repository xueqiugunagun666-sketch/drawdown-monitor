'use client';

import { useState } from 'react';
import { Decimal, formatPrice } from '../../lib/decimal.ts';
import { describeBasis } from '../../lib/pumpStyle.ts';

export interface HoldingRow {
  tokenId: string; chain: string; address: string; symbol: string | null; wallet: string;
  amount: string | null; priceUsd: string | null; valueUsd: string | null;
  monitored: boolean; filterReason: string | null; lastQuoteAt: number | null; decimalsKnown: boolean;
  /** 四个窗口里最高的当前倍数 */
  best: { multiple: string; timeframe: string; basis: string } | null;
}

/**
 * 金额加千位分隔符。$116097.28 要数位数才知道是十一万还是一百一十万，
 * 而合计是这一页最该一眼读懂的数字。
 *
 * 分组只作用于整数部分：Decimal 的小数位可能很长（memecoin 价格），
 * 交给 toLocaleString 会被四舍五入掉。
 */
export const usd = (v: string | null) => {
  if (v === null) return '—';
  const n = new Decimal(v);
  if (!n.gt(0)) return '$0';
  const fixed = n.gte(1) ? n.toFixed(2) : n.toFixed(4);
  const [int = '0', frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${grouped}${frac ? `.${frac}` : ''}`;
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

/**
 * 当前倍数的显示。
 *
 * 这是"高亮"的正解：冷启动 seed 出来的 FIRED 状态不产生报警
 * （不为进入监控之前的涨幅补报），所以只看报警记录的话，
 * 一个已经涨了 3 倍的币在页面上是完全不可见的 —— 用户会以为没在工作。
 */
function Multiple({ best }: { best: HoldingRow['best'] }) {
  if (!best) return null;
  const m = new Decimal(best.multiple);
  if (m.lt('1.2')) return null;                      // 没怎么动就不占位置
  const n = m.toNumber();
  const cls = n >= 5 ? 'text-[#7ef2b4]' : n >= 2 ? 'text-[#3fbf7f]' : 'text-neutral-400';
  return (
    <span className={`${cls} tabular-nums shrink-0`} title={describeBasis(best.timeframe, best.basis)}>
      {m.toFixed(1)}x
    </span>
  );
}

function Row({ h, alerted }: { h: HoldingRow; alerted: boolean }) {
  return (
    <li id={`holding-${h.tokenId}`}
      className={`rounded-lg px-3 py-2.5 scroll-mt-4 border ${
        // 刚报过警的行要一眼认出来 —— 用户是听到播报才来看的
        alerted ? 'border-[#3fbf7f] bg-[#3fbf7f]/10'
        : h.monitored ? 'surface-interactive'
        : 'border-neutral-900/50 bg-neutral-900/15'
      }`}>
      <div className="flex items-baseline gap-2">
        <span className={`text-[15px] font-medium ${h.monitored ? 'text-neutral-200' : 'text-neutral-500'}`}>
          {h.symbol ?? '未知代币'}
        </span>
        <span className="meta-label">{h.chain}</span>
        {/* 合约地址，点一下复制 —— 同名假币很多，最终认的是 CA。
            钱包名不显示：跨四条链就是同一个地址，写出来只是噪音 */}
        <button type="button" title={h.address ?? ''}
          onClick={() => { if (h.address) void navigator.clipboard?.writeText(h.address); }}
          className="text-xs font-mono text-neutral-600 hover:text-neutral-400 truncate">
          {h.address ? `${h.address.slice(0, 6)}…${h.address.slice(-4)}` : ''}
        </button>
        <Multiple best={h.best} />
        <span className={`ml-auto tabular-nums shrink-0 text-[15px] ${
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

export default function HoldingsTable(
  { holdings, alertedTokenIds = [] }: { holdings: HoldingRow[]; alertedTokenIds?: string[] },
) {
  const alerted = new Set(alertedTokenIds);
  const [showAll, setShowAll] = useState(false);
  // 按当前倍数从高到低排 —— 你想第一眼看到的是"什么在涨"，
  // 而不是"什么值钱"。没有倍数数据的沉到后面
  const byMultiple = (a: HoldingRow, b: HoldingRow) =>
    Number(b.best?.multiple ?? 0) - Number(a.best?.multiple ?? 0);
  // 刚报过警的排最前，其次按当前倍数
  const monitored = holdings.filter((h) => h.monitored).sort((a, b) => {
    const d = Number(alerted.has(b.tokenId)) - Number(alerted.has(a.tokenId));
    return d !== 0 ? d : byMultiple(a, b);
  });
  const filtered = holdings.filter((h) => !h.monitored);
  const total = monitored.reduce(
    (s, h) => (h.valueUsd ? s.plus(new Decimal(h.valueUsd)) : s), new Decimal(0));

  return (
    <section>
      <div className="flex items-end justify-between gap-4 mb-3 flex-wrap">
        <div>
          <h2 className="text-sm text-neutral-400">持仓</h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            监控中 {monitored.length}{filtered.length > 0 && ` · 已过滤 ${filtered.length}`}
          </p>
        </div>
        {/* 合计是这一页最重要的数字，原本是最小号字挤在右边缘 */}
        <div className="text-right">
          <div className="meta-label">合计</div>
          <div className="text-[22px] font-semibold tabular-nums leading-none mt-1 tracking-tight">
            {usd(total.toString())}
          </div>
        </div>
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-neutral-600">
          还没扫到持仓。加了钱包后，第一次扫描要等十几分钟。
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {monitored.map((h) => (
              <Row key={`${h.wallet}-${h.tokenId}`} h={h} alerted={alerted.has(h.tokenId)} />
            ))}
            {showAll && filtered.map((h) => (
              <Row key={`${h.wallet}-${h.tokenId}`} h={h} alerted={false} />
            ))}
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
