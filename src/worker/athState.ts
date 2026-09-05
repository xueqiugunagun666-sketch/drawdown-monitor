/**
 * ATH 突破的状态机。
 *
 * 要解决的问题是"上涨途中不断创新高"：60 秒一轮，一个涨一小时的币会
 * 产生 60 个新高。三道闸把它压成 1~3 条：
 *
 *   1. **状态机**（决定性的一道）—— 报的是"突破"这个**事件**，不是每个
 *      新高。ARMED 时突破报一条并转 FIRED，之后不再报；要等价格回落到
 *      ATH×REARM_RATIO 以下才重新武装。单调上涨全程只响一次。
 *   2. **突破幅度门槛** —— 必须超过旧 ATH 至少 BREAKOUT_MARGIN 才算突破，
 *      挡掉贴着高点来回蹭。实测这是频率的主要旋钮：0% 时 32 条/天，
 *      10% 时降到 10 条/天（2026-09-05，458 个监控币，最近 7 天）。
 *   3. **补报** —— FIRED 之后不再报新高，除非价格比上次报警又涨了
 *      ADVANCE_RATIO 倍。一波三倍的行情大约给 2~3 条。
 *
 * 与暴涨状态机（pumpState.ts）是两套独立的东西：暴涨说的是"从最近低点
 * 涨了 N 倍"，ATH 说的是"进入价格发现区，头上没有套牢盘"。一个币可以
 * 涨 5 倍还远在高点之下，也可以只涨 15% 就破新高。
 */
import { Decimal } from '../lib/decimal.ts';

/** 必须超过旧 ATH 这个比例才算突破。频率的主要旋钮 */
export const BREAKOUT_MARGIN = 0.10;

/** 回落到 ATH 的这个比例以下才重新武装。没有滞回的话，贴着高点震荡会反复报 */
export const REARM_RATIO = 0.8;

/** 已报过之后，价格要比上次报警再涨这么多才补一条 */
export const ADVANCE_RATIO = 1.5;

export type AthAlertState = 'ARMED' | 'FIRED';

export interface AthSnapshot {
  state: AthAlertState;
  /** 上次报警时的价格。补报跟它比 */
  lastAlertPrice: Decimal | null;
  /**
   * 突破的**参照线**：本轮武装时的历史最高，ARMED 期间冻结。
   *
   * 必须与"事实上的最高价"分开。第一版把两者当成一个东西，结果是
   * ARMED 期间 ATH 跟着价格涨、10% 门槛也跟着上移 —— 缓慢上涨永远够不到，
   * 一波三倍的行情一条都报不出来。参照线冻结才有"超过上一轮高点 10%"
   * 这个语义；而事实上的最高价照常更新，页面上「距 ATH 多远」要用它。
   */
  refAth: Decimal | null;
}

export interface AthInput {
  /** 当前价（用 5 分钟收盘价，不用最高价 —— 单根影线不算突破） */
  price: Decimal;
  /** 已知的历史最高。为 null 表示还没算出来，此时什么都不做 */
  ath: Decimal | null;
}

export type AthFireKind = 'breakout' | 'advance';

export interface AthResult {
  fire: AthFireKind | null;
  next: AthSnapshot;
  /** 突破后的新 ATH。调用方据此更新记录 */
  newAth: Decimal | null;
}

export function initialAthState(refAth: Decimal | null = null): AthSnapshot {
  return { state: 'ARMED', lastAlertPrice: null, refAth };
}

/**
 * 冷启动：一个币首次进入 ATH 判定时调用。
 *
 * 已经在 ATH 之上的直接置 FIRED —— **不为"它进入监控之前就破过新高"
 * 补报**。与暴涨那边的 seed 是同一条原则：刚加进来的币不该立刻炸一串
 * 历史事件。
 */
export function seedAthState(price: Decimal, ath: Decimal | null): AthSnapshot {
  if (ath === null) return initialAthState(null);
  const broke = price.gt(ath.mul(1 + BREAKOUT_MARGIN));
  return broke
    ? { state: 'FIRED', lastAlertPrice: price, refAth: ath }
    : initialAthState(ath);
}

export function evaluateAth(prev: AthSnapshot, input: AthInput): AthResult {
  const { price, ath } = input;

  // 还不知道历史最高就什么都不做 —— 没有基准，"突破"无从谈起
  if (ath === null || ath.lte(0)) {
    return { fire: null, next: prev, newAth: null };
  }

  // 事实上的最高价照常更新，与报不报无关
  const newAth = price.gt(ath) ? price : null;

  /** 参照线没记过时退回当前 ATH（首次判定、或旧数据没有这一列） */
  const ref = prev.refAth ?? ath;

  if (prev.state === 'ARMED') {
    if (price.gt(ref.mul(1 + BREAKOUT_MARGIN))) {
      return {
        fire: 'breakout',
        next: { state: 'FIRED', lastAlertPrice: price, refAth: ref },
        newAth: price,
      };
    }
    // 参照线保持冻结 —— 让它跟着涨，门槛就永远够不到
    return { fire: null, next: { ...prev, refAth: ref }, newAth };
  }

  /* ---- 已经报过（FIRED） ---- */

  /**
   * 重新武装必须**先判**。
   *
   * 否则会出这种错：ATH 已经长到 1000、上次报警价还是 120，价格跌到 700
   * —— 那是从高点回撤 30%，却因为「比 120 涨了 483%」被当成补报发出去。
   *
   * 重新武装时把参照线抬到当前的事实最高：下一轮突破要从这个新高点算起，
   * 而不是从很久以前那条线。
   */
  if (price.lt(ath.mul(REARM_RATIO))) {
    return { fire: null, next: { state: 'ARMED', lastAlertPrice: null, refAth: ath }, newAth };
  }

  /**
   * 补报**不压在突破门槛后面**。
   *
   * 突破之后 ATH 就等于当前价，"再超过 ATH 10%"要求一轮之内跳涨 10%，
   * 平滑上涨里根本走不到。补报的判据只有一个：比上次告诉你的价格
   * 又涨了 ADVANCE_RATIO 倍。
   */
  if (prev.lastAlertPrice !== null && price.gte(prev.lastAlertPrice.mul(ADVANCE_RATIO))) {
    return {
      fire: 'advance',
      next: { state: 'FIRED', lastAlertPrice: price, refAth: ref },
      newAth,
    };
  }

  return { fire: null, next: { ...prev, refAth: ref }, newAth };
}
