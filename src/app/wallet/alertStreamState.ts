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

/** 0 是合法快照边界，必须明确写进 URL，不能省略成“从当前最新开始”。 */
export function alertStreamUrl(cursor: number): string {
  return `/api/wallet/stream?since=${Math.max(0, Math.floor(cursor))}`;
}
