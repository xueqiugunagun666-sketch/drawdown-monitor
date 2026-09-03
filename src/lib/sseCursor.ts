/**
 * SSE 断点续传的游标解析。
 *
 * 单独拎出来是因为它有三个来源、优先级不能搞错，而搞错的表现是**静默的**：
 * 报警照常写进数据库、页面刷新后也看得见，只是当时没有播报。
 * 9-03 FLETCH 那次的 2 倍档就可能是这么丢的。
 */

/** 客户端首连时不带任何游标，从"此刻"开始 —— 历史由 /api/wallet/alerts 一次性加载 */
export function resolveCursor(
  lastEventId: string | null, sinceParam: string | null, nowSec: number,
): number {
  // Last-Event-ID 优先：浏览器自动重连时带的，每次重连都是最新的一条
  const fromHeader = toTs(lastEventId);
  if (fromHeader !== null) return fromHeader;

  /**
   * ?since 次之。EventSource 自动重连用的是建连时那个 URL，改不了，
   * 所以这条只在客户端**主动重建**连接时才有值（会话过期导致
   * EventSource 彻底关闭、不再自动重连的情况）。
   */
  const fromQuery = toTs(sinceParam);
  if (fromQuery !== null) return fromQuery;

  return nowSec;
}

/** 只接受正整数秒。0、负数、NaN、空串一律当作"没给" */
function toTs(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}
