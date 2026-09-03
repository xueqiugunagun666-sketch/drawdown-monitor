/**
 * 群聊淘金的轮询。
 *
 * 上游是游标式分页（after_id 只回更大的 id），所以轮询天然无损：
 * 不用去重、不用比时间戳、断多久都能接着拉。这也是这里没上 socket.io 的
 * 原因 —— 少一个依赖、少一条会断的长连接，代价只是延迟，而"从峰值跌了
 * 80%"本来就不是分秒必争的事。
 *
 * 一轮会**连续翻页直到拉空**：第一次接入时库里是空的，上游可能已经攒了
 * 几百条，一轮只拉一页就要等好多轮才追平。
 */
import { fetchTrashSignals, isConfigured, PAGE_LIMIT } from '../sources/trashSignals.ts';
import { fetchBatchQuotes } from '../sources/dexscreenerBatch.ts';
import { normalizeChain } from '../lib/chainLinks.ts';
import * as repo from '../db/trashRepo.ts';
import { setTokenLinks } from '../db/walletRepo.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';

const log = makeLogger('trash-poller');

/** 轮询间隔。回撤信号不是分秒必争的事，一分钟够了 */
export const POLL_INTERVAL_SECONDS = 60;

/**
 * 单轮最多翻几页。
 *
 * 防的是上游 next_after_id 不前进时把这一轮变成死循环 —— 那会把 worker
 * 卡住，而卡住是静默的：日志里什么都不会有，只是别的事都不跑了。
 * 20 页 × 100 条 = 2000 条，首次接入也够一轮追平。
 */
const MAX_PAGES_PER_TICK = 20;

export interface TrashDeps {
  fetchPage: typeof fetchTrashSignals;
  /** 取项目方绑定的官网/推特。可选 —— 不传就跳过，判定本身不依赖它 */
  fetchQuotes?: typeof fetchBatchQuotes;
}

export const realTrashDeps: TrashDeps = {
  fetchPage: fetchTrashSignals,
  fetchQuotes: fetchBatchQuotes,
};

/**
 * 给新收的信号补上官网/推特/电报。
 *
 * 必须单独做一次：setTokenLinks 平时是在**钱包币**的判定里顺带写的，
 * 而群聊淘金的币多半不在任何人钱包里 —— 不补的话线上那一栏一个社交
 * 按钮都不会有，而"没有按钮"和"这个币没绑社交"长得一模一样，
 * 不会有人发现。
 *
 * 成本：一天新增十几条，按 30 个地址一个请求，一天几次而已。
 * 失败不影响主流程 —— 外链是锦上添花，信号本身才是关键。
 */
async function fillLinks(
  signals: Array<{ chain: string; address: string }>, now: number,
  fetchQuotes: typeof fetchBatchQuotes,
): Promise<void> {
  const byChain = new Map<string, string[]>();
  for (const s of signals) {
    const chain = normalizeChain(s.chain);
    (byChain.get(chain) ?? byChain.set(chain, []).get(chain)!).push(s.address);
  }
  for (const [chain, addrs] of byChain) {
    try {
      for (const [addr, q] of await fetchQuotes(chain, addrs)) {
        // 键用**原始链名**：库里的 trash_signals.chain 存的是上游给的那个，
        // 页面按 `${r.chain}:${r.address}` 查，两边必须一致
        const orig = signals.find((s) => s.address.toLowerCase() === addr.toLowerCase())?.chain ?? chain;
        setTokenLinks(`${orig}:${addr}`, now, q);
      }
    } catch (err) {
      log.debug(`${chain} 取外链失败（不影响信号本身）: ${safeErrorMessage(err)}`);
    }
  }
}

export async function runTrashTick(now: number, deps: TrashDeps = realTrashDeps): Promise<number> {
  let cursor = repo.maxSignalId();
  let added = 0;

  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const res = await deps.fetchPage(cursor);
    if (res.signals.length === 0) break;

    const before = added;
    added += repo.insertSignals(res.signals, now);
    if (added > before && deps.fetchQuotes) {
      await fillLinks(res.signals, now, deps.fetchQuotes);
    }

    // 游标必须真的前进，否则就是上游给了个不动的 next_after_id，
    // 再翻下去就是同一页拉到天荒地老
    if (res.nextAfterId <= cursor) {
      log.warn(`游标没有前进（${cursor} -> ${res.nextAfterId}），本轮到此为止`);
      break;
    }
    cursor = res.nextAfterId;

    // 不满一页说明已经追到最新了
    if (res.signals.length < PAGE_LIMIT) break;
  }

  if (added > 0) log.info(`新增 ${added} 条喊单回撤信号（游标 ${cursor}）`);
  return added;
}

/** 循环。未配置接口时直接不启动，并说明原因 —— 静默不跑最难查 */
export function startTrashLoop(isStopping: () => boolean): void {
  if (!isConfigured()) {
    log.info('未配置 TRASH_API_BASE / TRASH_API_TOKEN，群聊淘金不启动');
    return;
  }
  const loop = async () => {
    while (!isStopping()) {
      const t0 = Date.now();
      try {
        await runTrashTick(Math.floor(Date.now() / 1000));
      } catch (err) {
        // 拉不到不能拖垮别的循环。令牌失效之类的会一直报，
        // 但那正是应该一直吵的事 —— 静默失败等于这一栏永远空着没人知道
        log.warn(`拉取失败: ${safeErrorMessage(err)}`);
      }
      const wait = POLL_INTERVAL_SECONDS * 1000 - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  };
  void loop();
}
