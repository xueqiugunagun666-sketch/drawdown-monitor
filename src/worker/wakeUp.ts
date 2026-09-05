/**
 * 「沉睡的币醒了」的判定。
 *
 * 冷启动规则原本是一刀切：一个币首次进入监控时，已经达标的档位直接标记
 * 为已触发但**不报**。理由是新加一个钱包时里面一堆早就涨过的币，不该
 * 炸一串历史报警 —— 这个理由对"刚扫到的持仓"成立。
 *
 * 但它对另一种情形是错的，而那正是最该报的一种：**币早就在钱包里，只是
 * 一直是粉尘（成交量不够）没进监控；行情启动后才被重新纳入**。这时"进入
 * 监控之前涨的那一段"恰恰就是用户最想知道的事。
 *
 * 2026-09-06 的 KANSO：持仓自 8-30 就在，拉盘前 24 小时成交量只有约 $154
 * 走慢车道；02:55 被重新纳入时价格已经 3.55 倍，2 倍和 3 倍档被静默吃掉，
 * 一直等到 5 倍才响 —— 那时已经 8.64 倍、市值从 5.6K 涨到 63K。
 *
 * 区分两者的信号很干净：**这个持仓在钱包里多久了**。刚扫到的是新加钱包，
 * 待了一阵子的是沉睡的币醒了。
 */
import { Decimal } from '../lib/decimal.ts';

/**
 * 持仓存在多久之后，"首次进入监控"就该按"沉睡的币醒了"处理。
 *
 * 一小时：钱包扫描本身要几分钟，新加的钱包在这个窗口内不会被误判；
 * 而一个真沉睡的币通常已经躺了几天。
 */
export const WOKE_UP_AFTER_SECONDS = 3600;

/**
 * 冷启动时是不是该补一条"它已经涨了多少"。
 *
 * @param firstSeenAt 这个币最早被扫到的时刻（多人持有时取最早的那个）
 */
export function isWakeUp(firstSeenAt: number | null, now: number): boolean {
  if (firstSeenAt === null) return false;
  return now - firstSeenAt >= WOKE_UP_AFTER_SECONDS;
}

/**
 * 醒来时该按哪个档位报。
 *
 * 报**已达到的最高档**，而不是最低档：一个进来就 3.55 倍的币，说它
 * "涨了 2 倍"是把信息说小了。低于它的档位一并置为已触发，不再补报。
 *
 * 返回 null 表示连最低档都没到，按普通冷启动处理（静默）。
 */
export function wakeUpLevel(multiple: Decimal, levels: readonly number[]): number | null {
  let best: number | null = null;
  for (const l of levels) if (multiple.gte(l)) best = l;
  return best;
}
