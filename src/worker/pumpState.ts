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

/** 同一个币在这个时长内只发一条报警 */
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
 * 同一个币的一波行情会让多个窗口先后达标。只发一条：
 * 倍数最高的优先；倍数相同时窗口更短的优先。
 *
 * 注意：没被选中的那些，状态机照样要置 FIRED，只是不产生通知。
 * 不置的话，去重窗口一过就会全部重放。
 */
export function pickWinner(fires: PendingFire[]): PendingFire | null {
  if (fires.length === 0) return null;
  return fires.reduce((best, f) => {
    const c = f.multiple.comparedTo(best.multiple);
    if (c > 0) return f;
    if (c < 0) return best;
    return WINDOW_SECONDS[f.timeframe] < WINDOW_SECONDS[best.timeframe] ? f : best;
  });
}

export function suppressedByRecent(lastAlertAt: number | null, now: number): boolean {
  return lastAlertAt !== null && now - lastAlertAt < DEDUP_WINDOW_SECONDS;
}
