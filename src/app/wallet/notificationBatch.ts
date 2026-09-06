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

function marketLabel(a: AlertRow, nameFor: (a: AlertRow) => string): string {
  const name = alertName(a, nameFor);
  if (a.kind === 'pump-ath') return `${name} ${pumpText(a)} · ${athText(a)}`;
  if (isAthKind(a.kind)) return `${name} ${athText(a)}`;
  return `${name} ${pumpText(a)}`;
}

function marketDetails(a: AlertRow): string[] {
  const details: string[] = [];
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
  const source = a.tokenId.split(':')[1] ?? a.tokenId;
  return source.toUpperCase();
}

/**
 * 最多两个浏览器通知：系统摘要与行情摘要各一条。页面的异动列表保存全部
 * 行；通知正文列出前几条并明确总数，避免几十条同批通知把用户轰炸掉。
 */
export function buildNotificationSpecs(
  batch: AlertBatch,
  nameFor: (a: AlertRow) => string,
): NotificationSpec[] {
  const specs: NotificationSpec[] = [];

  if (batch.system.length > 0) {
    const sources = [...new Set(batch.system.map(sourceName))];
    specs.push({
      channel: 'system',
      title: `监控系统有情况（${batch.system.length} 条）`,
      body: `报价源 ${sources.join('、')} 出现连续失败、缺失或偏价。`
        + `本批 ${batch.system.length} 条系统事件已保留在页面异动记录。`,
      tag: stableNotificationTag('system', batch.system),
      alertIds: batch.system.map((a) => a.id),
    });
  }

  if (batch.market.length > 0) {
    const preview = batch.market.slice(0, 5).map((a) => {
      const details = marketDetails(a);
      return `${marketLabel(a, nameFor)}${details.length > 0 ? `｜${details.join(' · ')}` : ''}`;
    });
    const rest = batch.market.length - preview.length;
    const suffix = rest > 0 ? `；另外 ${rest} 条已保留在页面异动记录` : '';
    specs.push({
      channel: 'market',
      title: `共 ${batch.market.length} 个行情异动`,
      body: `${preview.join('\n')}${suffix}`,
      tag: stableNotificationTag('market', batch.market),
      alertIds: batch.market.map((a) => a.id),
    });
  }

  return specs;
}
