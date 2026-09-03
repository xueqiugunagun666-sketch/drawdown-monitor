/**
 * SSE 断点续传的游标解析。
 *
 * 单独拎出来是因为它有三个来源、优先级不能搞错，而搞错的表现是**静默的**：
 * 报警照常写进数据库、页面刷新后也看得见，只是当时没有播报。
 *
 * 游标是 pump_alerts 的**写入序号（rowid）**，不是时间戳。
 * 用时间戳漏过一次真事故：FLETCH 那条 fired_at 记的是轮次**开始**的时刻
 * （17:24:14），但引擎遍历到这个币、真正写进库是 17:24:37 —— 差 23 秒。
 * 连接只要在这段间隔里重连，游标取"此刻"就已经越过了它，那条报警从此
 * 对推送永远不可见。同一轮里两条报警共用一个 fired_at 时也会互相顶掉。
 */

/**
 * 时间戳与序号的分界。行数不可能到十亿，而 unix 秒早就过十亿了，
 * 所以大于这个数的一律是**旧客户端**留下的时间戳游标（改版之前发出去的
 * Last-Event-ID）。当作"没给"处理 —— 退回不重播，而不是拿它当序号去比，
 * 那会让这个连接永远收不到任何东西。
 */
export const MAX_PLAUSIBLE_SEQ = 1_000_000_000;

/** 都没给时用 currentMaxSeq：新连接不重播历史（历史由 /api/wallet/alerts 一次性加载） */
export function resolveCursor(
  lastEventId: string | null, sinceParam: string | null, currentMaxSeq: number,
): number {
  // Last-Event-ID 优先：浏览器自动重连时带的，每次重连都是最新的一条
  const fromHeader = toSeq(lastEventId);
  if (fromHeader !== null) return fromHeader;

  /**
   * ?since 次之。EventSource 自动重连用的是建连时那个 URL，改不了，
   * 所以这条只在客户端**主动重建**连接时才有值（会话过期导致
   * EventSource 彻底关闭、不再自动重连的情况）。
   */
  const fromQuery = toSeq(sinceParam);
  if (fromQuery !== null) return fromQuery;

  return currentMaxSeq;
}

/** 只接受非负整数序号。0 是合法的（库里一条都还没有）；负数、NaN、时间戳一律当作"没给" */
function toSeq(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= MAX_PLAUSIBLE_SEQ) return null;
  return Math.floor(n);
}
