/**
 * 暴涨分档状态机。与 stateMachine.ts（回撤）是镜像关系但方向相反，
 * 且没有 confirm_ticks —— 暴涨要的是快，慢两拍就没意义了。
 *
 * 状态是**全局的**，键为 (token_id, timeframe, basis, level)，不按用户分。
 * 价格变动是全局事实，只有"通知谁"是每人不同的。
 * 这顺带解决了一个边界情况：B 用户新加的钱包持有一个已经是 FIRED 的币，
 * 状态机不会重复触发，B 自然收不到追溯报警。
 */
import { Decimal } from '../lib/decimal.ts';
import { WINDOW_SECONDS, type PumpTimeframe, type PumpBasis } from './pumpWindows.ts';

export const LEVELS = [2, 5, 10] as const;

/**
 * 回落到档位的这个比例以下才重新武装。
 * 没有滞回的话，一个在 2.0 附近震荡的币每次穿越都会报一次。
 */
export const REARM_RATIO = 0.8;

/** 同一个币在这个时长内，**同档或更低**的只发一条报警。更高的档位不受限，见 suppressedByRecent */
export const DEDUP_WINDOW_SECONDS = 1800;

export interface PumpSnapshot {
  state: 'ARMED' | 'FIRED';
  lastFiredAt: number | null;
}

export function initialPumpState(): PumpSnapshot {
  return { state: 'ARMED', lastFiredAt: null };
}

/**
 * 冷启动：一个币首次进入监控时调用。
 * 此刻已经达标的档位直接置 FIRED —— 不为"它进来之前就涨过"这件事补报。
 *
 * lastFiredAt 保持 null：它从没真的发出过报警，历史记录不该声称发过。
 */
export function seedPumpState(multiple: Decimal, level: number): PumpSnapshot {
  if (multiple.gte(level)) return { state: 'FIRED', lastFiredAt: null };
  return initialPumpState();
}

export interface PumpEvalParams {
  multiple: Decimal;
  level: number;
  now: number;
}

export function evaluatePump(
  prev: PumpSnapshot, { multiple, level, now }: PumpEvalParams,
): { fire: boolean; next: PumpSnapshot } {
  if (prev.state === 'FIRED') {
    // 严格小于才重新武装：正好等于 80% 仍算在滞回区内
    if (multiple.lt(new Decimal(level).mul(REARM_RATIO))) {
      return { fire: false, next: { state: 'ARMED', lastFiredAt: prev.lastFiredAt } };
    }
    return { fire: false, next: prev };
  }
  if (multiple.gte(level)) {
    return { fire: true, next: { state: 'FIRED', lastFiredAt: now } };
  }
  return { fire: false, next: prev };
}

export interface PendingFire {
  tokenId: string;
  timeframe: PumpTimeframe;
  basis: PumpBasis;
  level: number;
  multiple: Decimal;
  at: number;
}

/**
 * 同一个币的一波行情会让多个窗口、多个档位同时达标。只发一条，排序是：
 *   1. 倍数最高
 *   2. 倍数相同时**档位最高**
 *   3. 再相同时窗口最短（5 分钟涨 2 倍比 24 小时涨 2 倍更值得说）
 *
 * 第 2 条是补上的：同一个窗口的 2/5/10 三档算出来的 multiple 完全一样
 * （倍数是窗口的属性，不是档位的），所以原先只比倍数时三档并列，
 * 由第 3 条随便挑一个 —— 一个直接冲到 11 倍的币会被标成「2x 档」。
 * 标签本身误导，而且去重是按档位判的，记成 2 档会让随后真正的 5 档
 * 又响一次，等于为同一波行情吵两遍。
 *
 * 注意：没被选中的那些，状态机照样要置 FIRED，只是不产生通知。
 * 不置的话，去重窗口一过就会全部重放。
 */
export function pickWinner(fires: PendingFire[]): PendingFire | null {
  if (fires.length === 0) return null;
  return fires.reduce((best, f) => {
    const c = f.multiple.comparedTo(best.multiple);
    if (c !== 0) return c > 0 ? f : best;
    if (f.level !== best.level) return f.level > best.level ? f : best;
    return WINDOW_SECONDS[f.timeframe] < WINDOW_SECONDS[best.timeframe] ? f : best;
  });
}

export interface RecentAlert {
  /** 窗口内最后一条报警的时刻 */
  at: number;
  /** 窗口内报过的**最高档位**。判压制看的是它，不是时间 */
  level: number;
}

/**
 * 该不该压制这一条。
 *
 * **档位必须参与判断。** 早先的版本只问"最近 30 分钟报过没"，结果 2026-09-04
 * 的 PICKLES 是这样丢的：04:34 报了 2 倍档，之后 04:48 穿 5 倍、05:03 穿 10 倍，
 * 两条都落在压制窗口里，一条都没发。更糟的是状态机不管有没有发出去都把档位
 * 置成 FIRED（不置的话窗口一过会全部重放），于是这两档被**永久消耗** ——
 * 不是延迟，是再也不会报了。
 *
 * 去重窗口的本意是"别拿同一件事反复烦我"，而 2 倍 → 5 倍 → 10 倍是三件不同的
 * 事，一件比一件重要。所以：**比窗口内报过的最高档更高，就立刻放行**；
 * 同档或更低的才压制（那才是重复）。
 */
export function suppressedByRecent(
  recent: RecentAlert | null, now: number, level: number,
): boolean {
  if (recent === null) return false;
  if (now - recent.at >= DEDUP_WINDOW_SECONDS) return false;
  return level <= recent.level;
}
