/**
 * 群聊淘金：喊单回撤信号。
 *
 * 上游把各个微信群里被喊过的币盯着，峰值市值超过 100 万、又从峰值回撤
 * 80% 以上的，产生一条信号。规则由接口自己带出来（rule 字段），
 * 这边不复制一份 —— 复制就会有两个版本，早晚对不上。
 *
 * **游标式分页**：请求带 after_id，只回 id 更大的。这个设计让轮询天然
 * 无损：不用去重、不用比时间戳、断多久都能接着拉。所以这里用轮询而不是
 * 上游提供的 socket.io —— 少一个依赖、少一处会断的连接，代价只是延迟，
 * 而"从峰值跌了 80%"本来就不是分秒必争的事。
 *
 * **时间戳是北京时间**。上游给的是 "2026-09-04 04:39:02" 这种不带时区的
 * 字符串。实测过：刚触发的一条 triggered_at 是 04:39:02，本机 CST
 * 04:41:20，差两分钟 —— 是 UTC+8，不是 UTC。猜错就整体错 8 小时。
 */
import { httpGet } from '../lib/http.ts';
import { getSecrets } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';

export const SOURCE_ID = 'trash-signals';

/** 上游时间戳的时区偏移（秒）。北京时间 = UTC+8 */
const UPSTREAM_TZ_OFFSET = 8 * 3600;

export interface TrashSource {
  callerName: string | null;
  groupName: string | null;
  firstCallTime: number | null;
}

export interface TrashSignal {
  id: number;
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  peakMarketCap: number | null;
  currentMarketCap: number | null;
  drawdownPercent: number | null;
  firstCallTime: number | null;
  latestCallTime: number | null;
  triggeredAt: number | null;
  sources: TrashSource[];
}

export interface TrashPage {
  signals: TrashSignal[];
  nextAfterId: number;
  /** 上游自己声明的触发规则，原样透传给页面显示 */
  rule: Record<string, unknown> | null;
}

export function isConfigured(): boolean {
  const s = getSecrets();
  return Boolean(s.trashApiBase && s.trashApiToken);
}

/**
 * "2026-09-04 04:39:02"（北京时间）-> unix 秒。
 *
 * 不用 new Date(str)：那个在不同运行时对无时区字符串的解释不一致
 * （有的当本地时区、有的当 UTC），线上机器时区一改结果就变。
 * 手工拆分，时区偏移写死，行为与运行环境无关。
 */
export function parseUpstreamTime(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const utc = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!);
  if (!Number.isFinite(utc)) return null;
  return Math.floor(utc / 1000) - UPSTREAM_TZ_OFFSET;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface RawSource { caller_name?: unknown; group_name?: unknown; first_call_time?: unknown }
interface RawSignal {
  id?: unknown; chain?: unknown; address?: unknown; symbol?: unknown; name?: unknown;
  peak_market_cap?: unknown; current_market_cap?: unknown; drawdown_percent?: unknown;
  first_call_time?: unknown; latest_call_time?: unknown; triggered_at?: unknown;
  sources?: unknown;
}

/**
 * 解析一页。
 *
 * **只取展示需要的字段**：上游的 sources 里还有 caller_wxid 与 group_id，
 * 那是微信的个人与群标识，落到我们库里没有任何展示价值，只是把别人的
 * 身份信息搬到另一个多人共享的看板上。不收就不会泄。
 */
export function parseTrashPage(body: string, requestedAfterId: number): TrashPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'malformed',
      message: `非 JSON 响应: ${body.slice(0, 120)}`,
    });
  }
  const root = parsed as { signals?: unknown; next_after_id?: unknown; rule?: unknown };
  if (!Array.isArray(root.signals)) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: 'signals 不是数组' });
  }

  const signals: TrashSignal[] = [];
  for (const raw of root.signals as RawSignal[]) {
    const id = num(raw.id);
    const chain = str(raw.chain);
    const address = str(raw.address);
    // id / 链 / 地址缺一个这条就没法用：id 是去重键，另两个是身份
    if (id === null || !chain || !address) continue;

    const rawSources = Array.isArray(raw.sources) ? (raw.sources as RawSource[]) : [];
    signals.push({
      id,
      chain,
      address: address.toLowerCase(),
      symbol: str(raw.symbol),
      name: str(raw.name),
      peakMarketCap: num(raw.peak_market_cap),
      currentMarketCap: num(raw.current_market_cap),
      drawdownPercent: num(raw.drawdown_percent),
      firstCallTime: parseUpstreamTime(raw.first_call_time),
      latestCallTime: parseUpstreamTime(raw.latest_call_time),
      triggeredAt: parseUpstreamTime(raw.triggered_at),
      sources: rawSources.map((s) => ({
        callerName: str(s.caller_name),
        groupName: str(s.group_name),
        firstCallTime: parseUpstreamTime(s.first_call_time),
      })),
    });
  }

  /**
   * next_after_id 以本地算出来的最大 id 为准做兜底。
   * 上游若少给或给错，光信它会让游标卡住或者跳过 —— 前者永远收不到新的，
   * 后者永久丢数据，两种都是静默的。
   */
  const maxSeen = signals.reduce((m, s) => Math.max(m, s.id), requestedAfterId);
  const claimed = num(root.next_after_id);
  const nextAfterId = claimed !== null ? Math.max(claimed, maxSeen) : maxSeen;

  return {
    signals,
    nextAfterId,
    rule: (root.rule && typeof root.rule === 'object') ? root.rule as Record<string, unknown> : null,
  };
}

/** 一次最多拉多少条。上游默认 limit=100，够用 */
export const PAGE_LIMIT = 100;

export async function fetchTrashSignals(afterId: number): Promise<TrashPage> {
  const s = getSecrets();
  if (!s.trashApiBase || !s.trashApiToken) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '未配置接口地址或令牌' });
  }
  const url = `${s.trashApiBase.replace(/\/+$/, '')}/api/trash-signals`
    + `?after_id=${afterId}&limit=${PAGE_LIMIT}`;

  const res = await httpGet(url, 20_000, { authorization: `Bearer ${s.trashApiToken}` });
  if (res.status === 401 || res.status === 403) {
    // 令牌失效要说得明确 —— 混在 http_error 里会被当成对方临时抽风，
    // 而它是永久性的，不去换令牌就永远拉不到数据
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'http_error',
      message: `令牌被拒绝 (${res.status})，检查 TRASH_API_TOKEN`,
    });
  }
  if (res.status === 429) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'rate_limited', message: '429 限流' });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'http_error', message: `HTTP ${res.status}` });
  }
  return parseTrashPage(res.body, afterId);
}
