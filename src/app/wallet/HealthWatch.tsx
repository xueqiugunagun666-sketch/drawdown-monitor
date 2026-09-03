'use client';

import { useEffect, useRef } from 'react';
import {
  step, activeIssues, initialWatchState, describeIssue,
  type HealthIssue, type WatchState,
} from '../../lib/alertHealth.ts';
import { setTabAlarm } from '../../lib/tabAlarm.ts';
import { soundStatus, watchSoundStatus } from '../../lib/pumpSound.ts';

/**
 * 报警通路的看门狗。**不渲染任何东西** —— 页面内的横幅已经有了
 * （声音看 SoundToggle，推送看 WalletClient），这里只负责升级通道。
 *
 * 为什么必须是别的通道：提示音哑了的时候，页面横幅和静音一样看不见 ——
 * 人正是因为没听见才没在看页面。所以升级走系统通知（权限与音频自动播放
 * 是两套，音频被挂起时通知照样能弹）和标签页标题/图标（切到别的标签
 * 也看得见，而且不要任何权限）。
 *
 * 做不到的说清楚：网页整个关掉之后这里什么都做不了。那需要服务端推送。
 */
export default function HealthWatch({ streamConnected }: { streamConnected: boolean }) {
  const state = useRef<WatchState>(initialWatchState());
  /** 用 ref 读最新的外部状态，免得每次变化都重建定时器 */
  const connected = useRef(streamConnected);
  const audioOk = useRef(soundStatus() === 'ready');

  useEffect(() => { connected.current = streamConnected; }, [streamConnected]);
  useEffect(() => watchSoundStatus((s) => { audioOk.current = s === 'ready'; }), []);

  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const present = new Set<HealthIssue>();
      if (!audioOk.current) present.add('audio-dead');
      if (!connected.current) present.add('stream-down');

      const r = step(state.current, present, now);
      state.current = r.state;

      for (const issue of r.notify) {
        const d = describeIssue(issue);
        popup(d.title, d.body);
      }

      // 标签页告警跟着"当前确实有问题"走，不跟着弹窗走 ——
      // 弹窗只在变化时发一次，而标签页要一直挂着直到恢复
      const active = activeIssues(state.current, now);
      setTabAlarm(active.length === 0 ? null : describeIssue(active[0]!).title);
    };

    tick();
    const t = setInterval(tick, 1000);
    return () => {
      clearInterval(t);
      setTabAlarm(null);        // 离开页面别把标题留在告警状态
    };
  }, []);

  return null;
}

/**
 * 系统通知。
 *
 * requireInteraction 让它留在通知中心不自动消失 —— 这条消息的意义就是
 * "你现在收不到报警了"，一闪而过等于没发。
 *
 * 点一下把标签页调到前台，省得用户自己去一堆标签里翻。
 */
function popup(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: `health-${title}`, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* 某些浏览器在非 https 下会抛 */ }
}
