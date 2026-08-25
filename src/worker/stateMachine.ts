/**
 * 报警状态机 —— 规格 §2.6。每个 (token, rule, level) 独立。
 *
 *   ARMED --(drawdown >= level 连续 confirm_ticks 次 且 liq >= min_liq)--> FIRED
 *   FIRED --(drawdown <= level - hysteresis 持续 rearm_minutes)--> ARMED
 *
 * 另有全局 cooldown：同一代币任意档位之间的最小间隔。
 * 纯函数，不碰 DB，便于测试。
 */
import type { Decimal } from '../lib/decimal.ts';

export type AlertState = 'ARMED' | 'FIRED';

export interface StateSnapshot {
  state: AlertState;
  hitCount: number;
  /** 回落到重新武装区间的起始时刻；离开区间即清空 */
  rearmSinceTs: number | null;
  localLow: Decimal | null;
  localLowTs: number | null;
  lastFiredAt: number | null;
}

export interface EvalParams {
  drawdown: Decimal;
  price: Decimal;
  liquidityTotal: number;
  level: number;
  confirmTicks: number;
  hysteresis: number;
  rearmMinutes: number;
  minLiquidityUsd: number;
  cooldownMinutes: number;
  /** 该代币任意档位最近一次触发时刻，用于 cooldown */
  lastAnyFiredAt: number | null;
  now: number;
}

export interface EvalResult {
  next: StateSnapshot;
  fire: boolean;
  /** 未触发时的原因，供 UI/日志解释「为什么没报」 */
  blockedBy: 'liquidity' | 'cooldown' | 'confirming' | null;
}

export function evaluate(cur: StateSnapshot, p: EvalParams): EvalResult {
  const next: StateSnapshot = { ...cur };

  if (cur.state === 'ARMED') {
    const liqOk = p.liquidityTotal >= p.minLiquidityUsd;
    const levelHit = p.drawdown.gte(p.level);

    if (!levelHit) {
      next.hitCount = 0;
      return { next, fire: false, blockedBy: null };
    }
    if (!liqOk) {
      // 流动性不足：不累计确认次数，但明确告知原因，不静默丢弃
      next.hitCount = 0;
      return { next, fire: false, blockedBy: 'liquidity' };
    }

    next.hitCount = cur.hitCount + 1;
    if (next.hitCount < p.confirmTicks) {
      return { next, fire: false, blockedBy: 'confirming' };
    }

    const inCooldown =
      p.lastAnyFiredAt !== null && p.now - p.lastAnyFiredAt < p.cooldownMinutes * 60;
    if (inCooldown) {
      // 保留 hitCount —— cooldown 结束后应立即触发，而不是重新数 confirm_ticks
      return { next, fire: false, blockedBy: 'cooldown' };
    }

    next.state = 'FIRED';
    next.lastFiredAt = p.now;
    next.localLow = p.price;
    next.localLowTs = p.now;
    next.rearmSinceTs = null;
    return { next, fire: true, blockedBy: null };
  }

  // FIRED：追踪局部低点（Phase 3 的 bounce 规则要用）
  if (cur.localLow === null || p.price.lt(cur.localLow)) {
    next.localLow = p.price;
    next.localLowTs = p.now;
  }

  // 重新武装：需持续 rearm_minutes
  const rearmZone = p.drawdown.lte(p.level - p.hysteresis);
  if (!rearmZone) {
    next.rearmSinceTs = null;
    return { next, fire: false, blockedBy: null };
  }
  const since = cur.rearmSinceTs ?? p.now;
  next.rearmSinceTs = since;
  if (p.now - since >= p.rearmMinutes * 60) {
    next.state = 'ARMED';
    next.hitCount = 0;
    next.rearmSinceTs = null;
    next.localLow = null;
    next.localLowTs = null;
  }
  return { next, fire: false, blockedBy: null };
}

export function initialState(): StateSnapshot {
  return { state: 'ARMED', hitCount: 0, rearmSinceTs: null, localLow: null, localLowTs: null, lastFiredAt: null };
}
