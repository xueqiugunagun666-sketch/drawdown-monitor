/**
 * 告警的**发出**动作，从 HealthWatch 里抽出来单独放。
 *
 * 抽出来是为了让「测试告警」按钮走的是真实这条路，而不是另写一份模拟：
 * 一个从没被验证过的告警不算告警，而如果测试走的是另一份代码，
 * 测试通过也证明不了真出事时会响。
 */
import { setTabAlarm, holdTabAlarm, releaseTabAlarm, tabAlarmActive } from './tabAlarm.ts';

export type NotifyChannel = 'granted' | 'denied' | 'default' | 'unsupported';

/** 系统通知这条通道现在能不能用。测试要如实报出来，不能只说"已发送" */
export function notifyChannel(): NotifyChannel {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotifyChannel;
}

/**
 * 弹系统通知。返回是否真的弹出去了 —— 调用方要能如实告诉用户。
 *
 * requireInteraction 让它留在通知中心不自动消失：这条消息的意义就是
 * "你现在收不到报警了"，一闪而过等于没发。
 * 点一下把标签页调到前台，省得用户去一堆标签里翻。
 */
export function popup(title: string, body: string, tag: string): boolean {
  if (notifyChannel() !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;                 // 某些浏览器在非 https 下会抛
  }
}

export interface AlertOutcome {
  /** 系统通知真的弹出去了吗 */
  notified: boolean;
  /** 标签页真的进入告警了吗 —— 读回来的，不是假定的 */
  tabAlarmed: boolean;
}

/**
 * 把一条告警发出去：系统通知 + 标签页。
 *
 * holdMs 给测试用：在这段时间里独占标签页，不让看门狗每秒的常规刷新覆盖掉。
 * 常规告警不传它 —— 看门狗本来就会一直把告警写着，不需要占用。
 *
 * 两个渠道的结果都**读回真实状态**再返回。测试如果只是写死"已发送"，
 * 就会像第一版那样报告"标签页告警 ✓"而标签栏上什么都没发生。
 */
export function raiseAlert(title: string, body: string, tag: string, holdMs?: number): AlertOutcome {
  const notified = popup(title, body, tag);
  if (holdMs) holdTabAlarm(title, holdMs);
  else setTabAlarm(title);
  return { notified, tabAlarmed: tabAlarmActive() };
}

export function clearAlert(): void {
  releaseTabAlarm();
}
