import type { AlertRow } from './AlertFeed.tsx';

/** 历史刷新只能合并，不能把已经由 SSE 到达的新报警覆盖掉。 */
export function mergeAlertRows(current: AlertRow[], incoming: AlertRow[]): AlertRow[] {
  const byId = new Map<string, AlertRow>();
  for (const row of current) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return b.seq - a.seq;
    if (a.firedAt !== b.firedAt) return b.firedAt - a.firedAt;
    return b.id.localeCompare(a.id);
  });
}

/**
 * `source-down` 是一次故障事件，不是当前状态。源恢复后事件仍留在审计库，
 * 但页面不能继续拿旧事件声称“能力已暂停”。行情事件永远不参与这层过滤。
 */
export function filterInactiveSourceAlerts(
  rows: AlertRow[], activeSourceFailures: readonly string[],
): AlertRow[] {
  const active = new Set(activeSourceFailures);
  return rows.filter((row) => {
    if (row.kind !== 'source-down') return true;
    if (!row.tokenId.startsWith('system:')) return false;
    return active.has(row.tokenId.slice('system:'.length));
  });
}

/** 0 是合法快照边界，必须明确写进 URL，不能省略成“从当前最新开始”。 */
export function alertStreamUrl(cursor: number): string {
  return `/api/wallet/stream?since=${Math.max(0, Math.floor(cursor))}`;
}
