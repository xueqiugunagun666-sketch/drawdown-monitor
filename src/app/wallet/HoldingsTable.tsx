'use client';

import { useState } from 'react';
import { Decimal, formatPrice } from '../../lib/decimal.ts';
import { describeBasis } from '../../lib/pumpStyle.ts';
import { copyText } from '../../lib/copy.ts';
import ValueFilter from './ValueFilter.tsx';
import { money } from '../trash/TrashList.tsx';
import TokenLinks from '../../components/TokenLinks.tsx';

export interface HoldingRow {
  tokenId: string; chain: string; address: string; symbol: string | null; wallet: string;
  amount: string | null; priceUsd: string | null; valueUsd: string | null;
  monitored: boolean; filterReason: string | null; lastQuoteAt: number | null; decimalsKnown: boolean;
  websiteUrl?: string | null; twitterUrl?: string | null; telegramUrl?: string | null;
  /** 当前市值，与 priceUsd 同源 */
  marketCapUsd?: number | null;
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
/**
 * 搜索匹配。CA 与币名都能匹配 —— 你可能记得名字，也可能只有从
 * 区块浏览器复制来的地址。
 *
 * 地址不区分大小写：EVM 地址常见校验和大小写混写（0xAbC…），
 * 而人从各处复制来的写法五花八门，区分大小写等于搜不到。
 */
export function matchesQuery(h: HoldingRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (h.address?.toLowerCase().includes(q)) return true;
  if (h.symbol?.toLowerCase().includes(q)) return true;
  if (h.chain?.toLowerCase() === q) return true;
  return false;
}

/** 窗口的短标签。表格里没有位置写"24 小时内从低点"，但必须让人知道是哪个窗口 */
const TF_SHORT: Record<string, string> = { '5m': '5分', '1h': '1时', '6h': '6时', '24h': '24时' };

function Multiple({ best }: { best: HoldingRow['best'] }) {
  if (!best) return null;
  const m = new Decimal(best.multiple);
  if (m.lt('1.2')) return null;                      // 没怎么动就不占位置
  const n = m.toNumber();
  const cls = n >= 5 ? 'text-[#7ef2b4]' : n >= 2 ? 'text-[#3fbf7f]' : 'text-neutral-400';
  return (
    // 窗口标签必须显示出来，不能只放在 title 里 ——
    // 手机上没有 hover，"9.8x"不说明是 5 分钟还是 24 小时，
    // 这两者的意义天差地别
    <span className={`${cls} tabular-nums shrink-0 whitespace-nowrap`}
      title={describeBasis(best.timeframe, best.basis)}>
      {m.toFixed(1)}x
      <span className="text-neutral-600 text-[11px] ml-0.5 font-normal">
        {TF_SHORT[best.timeframe] ?? best.timeframe}
        {best.basis === 'low' ? '低' : '起'}
      </span>
    </span>
  );
}

/**
 * 合约地址，点一下复制。同名假币很多，最终认的是 CA。
 * 原本点了没有任何反馈 —— 复制失败时用户拿着空剪贴板走人。
 */
function CopyAddress({ address, tokenId }: { address: string; tokenId: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'selected'>('idle');
  if (!address) return null;
  const id = `ca-${tokenId}`;
  return (
    <button type="button" title={address}
      onClick={async () => {
        setState(await copyText(address, id) ? 'ok' : 'selected');
        setTimeout(() => setState('idle'), 1600);
      }}
      className={`text-xs font-mono truncate transition-colors ${
        state === 'ok' ? 'text-[#3fbf7f]'
        : state === 'selected' ? 'text-[#fab219]'
        : 'text-neutral-600 hover:text-neutral-400'
      }`}>
      <span id={id}>{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
      {state === 'ok' && <span className="ml-1">已复制</span>}
      {state === 'selected' && <span className="ml-1">已选中</span>}
    </button>
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
            钱包备注会进通知；列表保持紧凑，不在每个币上重复钱包名。 */}
        <CopyAddress address={h.address} tokenId={h.tokenId} />
        <TokenLinks chain={h.chain} address={h.address}
          websiteUrl={h.websiteUrl} twitterUrl={h.twitterUrl} telegramUrl={h.telegramUrl} />
        <Multiple best={h.best} />
        <span className={`ml-auto tabular-nums shrink-0 text-[15px] ${
          h.monitored ? 'text-neutral-200' : 'text-neutral-500'
        }`}>
          {usd(h.valueUsd)}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-0.5 text-xs text-neutral-600">
        {/* 市值排在最前、颜色更亮 —— 判断"这币现在多大"靠它，
            而价格是一串要数零的小数，量级信息几乎读不出来 */}
        {h.marketCapUsd != null && (
          <span className="tabular-nums text-[13px] text-neutral-300 font-medium">
            {money(h.marketCapUsd)}
          </span>
        )}
        <span className="tabular-nums">{amount(h.amount)}</span>
        <span>@</span>
        <span className="tabular-nums">{price(h.priceUsd)}</span>
        {/* 没进监控必须说明原因，不能让币静静消失（第 4 条铁律） */}
        <span className={`ml-auto shrink-0 text-right ${h.monitored ? 'text-[#3fbf7f]' : 'text-neutral-500'}`}>
          {h.monitored ? '监控中' : h.filterReason ?? '待行情评估'}
        </span>
      </div>
    </li>
  );
}

/**
 * 低于阈值的算粉尘。
 *
 * 价值算不出来的（还没拿到报价）**不算粉尘**，照常显示 ——
 * 与报警那边同一条原则：算不出来说明数据有问题，
 * 不能因为算不出而静静藏起来。
 */
export function isDust(h: HoldingRow, floor: number): boolean {
  if (floor <= 0) return false;
  if (h.valueUsd === null) return false;
  return new Decimal(h.valueUsd).lt(floor);
}

/**
 * “尚未评估”和“已评估但不达标”必须分开。
 *
 * 两者以前都被塞进 filtered 并默认折叠，导致刚扫出的真实持仓在页面上看起来
 * 像 0。filterReason=null 表示行情/过滤器还没轮到它，不是已经决定不监控。
 */
export function holdingBuckets(holdings: HoldingRow[], minValue: number) {
  const inMonitor = holdings.filter((h) => h.monitored);
  return {
    monitored: inMonitor.filter((h) => !isDust(h, minValue)),
    dust: inMonitor.filter((h) => isDust(h, minValue)),
    pending: holdings.filter((h) => !h.monitored && h.filterReason === null),
    filtered: holdings.filter((h) => !h.monitored && h.filterReason !== null),
  };
}

/** 所有取得报价的实际持仓合计；没有任何报价时返回 null，不能伪装成 $0。 */
export function quotedHoldingValue(holdings: HoldingRow[]): {
  total: string | null; quotedCount: number;
} {
  const quoted = holdings.filter((h) => h.valueUsd !== null);
  if (quoted.length === 0) return { total: null, quotedCount: 0 };
  const total = quoted.reduce(
    (sum, h) => sum.plus(new Decimal(h.valueUsd!)), new Decimal(0));
  return { total: total.toString(), quotedCount: quoted.length };
}

export default function HoldingsTable(
  { holdings, alertedTokenIds = [], minValue = 0, onSaveMinValue }:
  {
    holdings: HoldingRow[]; alertedTokenIds?: string[]; minValue?: number;
    /** 返回错误文案，null 表示保存成功。不传就不显示阈值入口 */
    onSaveMinValue?: (v: number) => Promise<string | null>;
  },
) {
  const alerted = new Set(alertedTokenIds);
  const [showAll, setShowAll] = useState(false);
  const [showDust, setShowDust] = useState(false);
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;

  // 按当前倍数从高到低排 —— 你想第一眼看到的是"什么在涨"，
  // 而不是"什么值钱"。没有倍数数据的沉到后面
  const byMultiple = (a: HoldingRow, b: HoldingRow) =>
    Number(b.best?.multiple ?? 0) - Number(a.best?.multiple ?? 0);

  const hit = holdings.filter((h) => matchesQuery(h, query));
  const byAlertThenMultiple = (a: HoldingRow, b: HoldingRow) => {
    const d = Number(alerted.has(b.tokenId)) - Number(alerted.has(a.tokenId));
    return d !== 0 ? d : byMultiple(a, b);
  };
  // 刚报过警的排最前，其次按当前倍数
  /**
   * 粉尘单独一组而不是直接扔掉：它们仍然在监控、涨幅照常算，
   * 只是不值得占据视线。用户随时能展开看见 —— 币不能静静消失。
   */
  const buckets = holdingBuckets(hit, minValue);
  const monitored = buckets.monitored.sort(byAlertThenMultiple);
  const dust = buckets.dust.sort(byAlertThenMultiple);
  const pending = buckets.pending.sort(byAlertThenMultiple);
  const filtered = buckets.filtered.sort(byAlertThenMultiple);

  // 合计按全部已取得报价的真实持仓算，不随搜索、过滤状态或小额阈值变化。
  // 全部还没报价时必须显示“—”，显示 $0 会让用户以为链上余额也是 0。
  const value = quotedHoldingValue(holdings);

  return (
    <section>
      <div className="flex items-end justify-between gap-4 mb-3 flex-wrap">
        <div>
          <h2 className="text-sm text-neutral-400">持仓</h2>
          <p className="text-xs text-neutral-600 mt-0.5">
            {searching
              ? `搜索结果 ${hit.length}`
              : `持仓 ${holdings.length} · 监控中 ${monitored.length}`
                + (pending.length > 0 ? ` · 待评估 ${pending.length}` : '')
                + (dust.length > 0 ? ` · 小额 ${dust.length}` : '')
                + (filtered.length > 0 ? ` · 已过滤 ${filtered.length}` : '')}
          </p>
          {/* 阈值放在它影响的那个数字旁边：改完，上面那行的「小额 N」当场就变 */}
          {onSaveMinValue && (
            <div className="mt-1.5">
              <ValueFilter value={minValue} onSave={onSaveMinValue} />
            </div>
          )}
        </div>
        {/* 合计是这一页最重要的数字，原本是最小号字挤在右边缘 */}
        <div className="text-right">
          <div className="meta-label">已报价持仓合计</div>
          <div className="text-[22px] font-semibold tabular-nums leading-none mt-1 tracking-tight">
            {usd(value.total)}
          </div>
          {holdings.length > 0 && (
            <div className="text-[11px] text-neutral-600 mt-1">
              已报价 {value.quotedCount}/{holdings.length}
            </div>
          )}
        </div>
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-neutral-600">
          还没扫到持仓。新钱包会优先扫描；进度和错误请看上方各链状态。
        </p>
      ) : (
        <>
          {/* 一千多条持仓靠翻是找不到的。搜索时连被过滤的一起搜 ——
              最常见的问题恰恰是"我这个币为什么没被监控" */}
          <div className="relative mb-2">
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="搜合约地址或币名" spellCheck={false}
              aria-label="搜索持仓"
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg
                         pl-3 pr-9 py-2 text-sm text-neutral-200 placeholder-neutral-600
                         focus:border-neutral-600 outline-none font-mono"
            />
            {searching && (
              <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-600
                           hover:text-neutral-300 text-lg leading-none px-1">
                ×
              </button>
            )}
          </div>

          {searching && (
            <p className="text-xs text-neutral-600 mb-2">
              {hit.length === 0
                ? '你的持仓里没有这个币。可能是还没扫到，或者余额已经清零。'
                : `找到 ${hit.length} 个${filtered.length > 0 ? `（其中 ${filtered.length} 个未监控）` : ''}`}
            </p>
          )}

          <ul className="space-y-1.5">
            {monitored.map((h) => (
              <Row key={`${h.wallet}-${h.tokenId}`} h={h} alerted={alerted.has(h.tokenId)} />
            ))}
            {/* 待评估是真实持仓，默认显示；折叠它们会让“121 条”看起来像 0。 */}
            {pending.map((h) => (
              <Row key={`${h.wallet}-${h.tokenId}`} h={h} alerted={false} />
            ))}
            {/* 搜索时小额与被过滤的都直接展开 ——
                最常见的问题恰恰是"我这个币怎么不见了" */}
            {(showDust || searching) && dust.map((h) => (
              <Row key={`${h.wallet}-${h.tokenId}`} h={h} alerted={alerted.has(h.tokenId)} />
            ))}
            {(showAll || searching) && filtered.map((h) => (
              <Row key={`${h.wallet}-${h.tokenId}`} h={h} alerted={false} />
            ))}
          </ul>

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {!searching && dust.length > 0 && (
              <button type="button" onClick={() => setShowDust(!showDust)}
                className="text-xs text-neutral-600 hover:text-neutral-400">
                {showDust ? '收起小额的' : `显示小额的 ${dust.length} 个（低于 $${minValue}）`}
              </button>
            )}
            {!searching && filtered.length > 0 && (
              <button type="button" onClick={() => setShowAll(!showAll)}
                className="text-xs text-neutral-600 hover:text-neutral-400">
                {showAll ? '收起被过滤的' : `显示被过滤的 ${filtered.length} 个（流动性或成交量不足）`}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
