import { Decimal } from '../../lib/decimal.ts';
import { baseMarketCap } from '../../lib/alertMarketCap.ts';
import { describeBasis } from '../../lib/pumpStyle.ts';
import { humanAgo } from '../../lib/time.ts';
import { money } from '../trash/TrashList.tsx';
import { usd } from './HoldingsTable.tsx';
import type { AlertRow } from './AlertFeed.tsx';

/**
 * 浏览器收到的一次 SSE pump payload 的批次类型。
 *
 * 这不是服务端事件 ID，也不是新的游标协议：它只决定这一批在浏览器里
 * 怎么合并声音和系统通知。每一行仍以 alert id 为唯一身份，不能按币名或
 * tokenId 合并，因为同一个币可以同时有暴涨、ATH 两个不同原因。
 */
export type AlertSoundKind =
  | 'system'
  | 'pump'
  | 'ath'
  | 'pump-and-ath'
  | 'system-and-market';

export interface AlertBatch {
  rows: AlertRow[];
  market: AlertRow[];
  system: AlertRow[];
  sound: AlertSoundKind | null;
}

export interface NotificationSpec {
  channel: 'system' | 'market';
  title: string;
  body: string;
  tag: string;
  alertIds: string[];
}

export function isAthKind(kind: string | null | undefined): boolean {
  return kind === 'ath' || kind === 'ath-advance' || kind === 'pump-ath';
}

export function isPumpKind(kind: string | null | undefined): boolean {
  return kind === 'level' || kind === 'advance' || kind === 'pump-ath'
    || kind === null || kind === undefined;
}

/** 用 Decimal 格式化倍数；格式化失败时也不能把 NaN 带进通知文案。 */
export function formatMultiple(multiple: string | null | undefined): string | null {
  if (!multiple) return null;
  try {
    const d = new Decimal(multiple);
    return d.isFinite() && d.gt(0) ? d.toFixed(1) : null;
  } catch {
    return null;
  }
}

/** 用 Decimal 计算 ATH 超过前高的百分比。 */
export function formatAthDelta(multiple: string | null | undefined): string | null {
  if (!multiple) return null;
  try {
    const d = new Decimal(multiple);
    if (!d.isFinite() || d.lte(0)) return null;
    const pct = d.sub(1).mul(100);
    if (!pct.isFinite()) return null;
    return `高出 ${pct.lt(10) ? pct.toFixed(1) : pct.toFixed(0)}%`;
  } catch {
    return null;
  }
}

/**
 * 按事件 id 去重并拆分系统/行情；保留输入顺序，便于页面与 SSE 的 seq 顺序
 * 一致。系统消息不再通过“挑一条 top”吞掉行情消息。
 */
export function buildAlertBatch(alerts: readonly AlertRow[]): AlertBatch {
  const rows = [...new Map(alerts.map((a) => [a.id, a])).values()];
  const system = rows.filter((a) => a.kind === 'source-down');
  const market = rows.filter((a) => a.kind !== 'source-down');
  const hasAth = market.some((a) => isAthKind(a.kind));
  // 未知的非 ATH kind 仍按行情事件处理，不能因为后端新增一种 pump kind
  // 就让这一批没有声音。
  const hasPump = market.some((a) => !isAthKind(a.kind) || isPumpKind(a.kind));

  let sound: AlertSoundKind | null = null;
  if (system.length > 0 && market.length > 0) sound = 'system-and-market';
  else if (system.length > 0) sound = 'system';
  else if (hasAth && hasPump) sound = 'pump-and-ath';
  else if (hasAth) sound = 'ath';
  else if (market.length > 0) sound = 'pump';

  return { rows, market, system, sound };
}

/**
 * tag 不再使用会变化的标题。加入事件 id 与 seq 后，同一事件重放仍落在同一
 * tag；两个同名币或同一个币的两个不同事件不会互相替换。
 */
export function stableNotificationTag(
  channel: NotificationSpec['channel'], alerts: readonly AlertRow[],
): string {
  const identity = [...new Set(alerts.map((a) => `${a.id}:${a.seq ?? 'no-seq'}`))]
    .sort()
    .join('|');
  return `show-tools-alert-${channel}-${identity || 'empty'}`;
}

function alertName(a: AlertRow, nameFor: (a: AlertRow) => string): string {
  return nameFor(a) || a.symbol || a.address || a.tokenId;
}

function athText(a: AlertRow): string {
  return a.kind === 'ath-advance' ? '再创新高' : `破${a.athScope ?? '新高'}`;
}

function pumpText(a: AlertRow): string {
  const multiple = formatMultiple(a.multiple);
  const multipleText = multiple ? `${multiple}x` : '倍数未知';
  const tier = a.level > 0 ? `（${a.level}x档）` : '';
  return `${a.kind === 'advance' ? '又涨' : '暴涨'} ${multipleText}${tier}`;
}

function marketAction(a: AlertRow): string {
  if (a.kind === 'pump-ath') return `${pumpText(a)} · ${athText(a)}`;
  if (isAthKind(a.kind)) return athText(a);
  return pumpText(a);
}

function chainLabel(a: AlertRow): string {
  const chain = (a.chain ?? a.tokenId.split(':')[0] ?? '').trim().toLowerCase();
  const known: Record<string, string> = {
    ethereum: 'Ethereum',
    bsc: 'BSC',
    base: 'Base',
    robinhood: 'Robinhood',
    solana: 'Solana',
  };
  return known[chain] ?? (chain ? chain.toUpperCase() : '未知链');
}

function marketTitle(a: AlertRow, nameFor: (a: AlertRow) => string): string {
  const icon = a.kind === 'pump-ath' ? '🚀🏆' : isAthKind(a.kind) ? '🏆' : '🚀';
  return `${icon} ${alertName(a, nameFor)}｜${chainLabel(a)}｜${marketAction(a)}`;
}

function marketDetails(a: AlertRow): string[] {
  const details: string[] = [];
  if (a.priceSource === 'xxyy') details.push('报价 XXYY');
  if (a.walletLabels && a.walletLabels.length > 0) {
    details.push(`地址 ${a.walletLabels.join('、')}`);
  }
  const marketCapUsd = a.marketCapUsd ?? null;
  const baseMc = baseMarketCap(marketCapUsd, a.priceUsd, a.basePriceUsd);
  if (marketCapUsd !== null) {
    details.push(`市值 ${baseMc !== null ? `${money(baseMc)} → ` : ''}${money(marketCapUsd)}`);
  }
  if (isAthKind(a.kind)) {
    const delta = formatAthDelta(a.multiple);
    if (delta) details.push(delta);
    if (a.baseTs) details.push(`前高立于 ${humanAgo(a.baseTs)}`);
  }
  if (isPumpKind(a.kind)) details.push(describeBasis(a.timeframe, a.basis));
  if (a.valueUsd) details.push(`持仓 ${usd(a.valueUsd)}`);
  return details;
}

function sourceName(a: AlertRow): string {
  const source = a.tokenId.split(':').slice(1).join(':') || a.tokenId;
  return source.toUpperCase();
}

function systemNotificationText(a: AlertRow): { title: string; body: string } {
  const source = sourceName(a);
  if (source === 'XXYY-SOLANA-RPC') {
    return {
      title: '⚠️ Solana 钱包 RPC 异常',
      body: '连续多次无法完整读取 SPL Token 与 Token-2022 持仓。旧持仓已保留，未误判为卖出。'
        + '可在设置页查看数据源状态。',
    };
  }
  if (source === 'XXYY' || source.startsWith('XXYY-ALERTS:')) {
    const chain = source.includes(':') ? `（${source.split(':')[1]}）` : '';
    return {
      title: `⚠️ XXYY 主报价异常${chain}`,
      body: 'XXYY 连续多轮请求失败或有效报价覆盖率异常，钱包暴涨与 ATH 报警已暂停。'
        + '回撤看板仍继续使用 DexScreener，可在设置页查看数据源状态。',
    };
  }
  return {
    title: `⚠️ 数据源 ${source} 异常`,
    body: `${source} 连续多轮异常，相关能力已暂停。可在设置页查看数据源状态。`,
  };
}

/**
 * 一事件一条浏览器通知。声音仍按 SSE 批次合并，但 Chrome 横幅不能再把
 * FLETCH 这种首次 2x 藏进“共 N 个异动”的摘要里。每条使用自己的事件
 * id/seq 作为 tag，因此同批币互不替换，断线重放又不会制造重复横幅。
 */
export function buildNotificationSpecs(
  batch: AlertBatch,
  nameFor: (a: AlertRow) => string,
): NotificationSpec[] {
  const specs: NotificationSpec[] = [];

  for (const alert of batch.system) {
    const text = systemNotificationText(alert);
    specs.push({
      channel: 'system',
      title: text.title,
      body: text.body,
      tag: stableNotificationTag('system', [alert]),
      alertIds: [alert.id],
    });
  }

  for (const alert of batch.market) {
    const details = marketDetails(alert);
    specs.push({
      channel: 'market',
      title: marketTitle(alert, nameFor),
      body: details.length > 0 ? details.join(' · ') : '点击查看异动详情',
      tag: stableNotificationTag('market', [alert]),
      alertIds: [alert.id],
    });
  }

  return specs;
}
