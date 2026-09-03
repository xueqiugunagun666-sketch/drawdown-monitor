'use client';

import { useEffect, useRef, useState } from 'react';
import { raiseAlert, clearAlert, notifyChannel } from '../../lib/healthAlert.ts';
import {
  soundStatus, playPumpSound, currentVoiceName, requestNotificationPermission,
} from '../../lib/pumpSound.ts';

/**
 * 「测试告警」—— 当场跑一遍真出事时会发生的全部动作。
 *
 * 一个从没被验证过的告警不算告警。这个按钮走的是**真实那条路**
 * （lib/healthAlert 的 raiseAlert），不是另写一份模拟 —— 否则测试通过
 * 也证明不了真出事时会响。
 *
 * 结果要**如实分渠道报**，不能笼统说"已发送"：系统通知没授权就是弹不
 * 出来，这正是用户最需要提前知道的事 —— 等真出事再发现没授权就晚了。
 */

/** 告警样子给人看几秒就撤掉，别让标签页一直挂着假告警 */
const HOLD_MS = 8000;

interface Result {
  notify: 'ok' | 'denied' | 'default' | 'unsupported';
  tab: boolean;
  sound: 'ok' | 'suspended' | 'locked' | 'no-voice';
}

export default function AlarmTest() {
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    clearTimeout(timer.current);
    clearAlert();               // 组件卸载时别把标题留在告警状态
  }, []);

  const run = () => {
    setRunning(true);

    const s = soundStatus();
    const sound: Result['sound'] =
      s === 'locked' ? 'locked'
      : s !== 'ready' ? 'suspended'
      : currentVoiceName() === null ? 'no-voice'
      : 'ok';
    if (s === 'ready') playPumpSound();          // 真出事时会响的那一声

    const out = raiseAlert(
      '这是一条测试告警',
      '真的出事时长这样。看到这条说明系统通知这条路是通的 —— '
      + '提示音失效或推送断开时，你会收到同样的提醒。',
      'health-test',
      HOLD_MS,
    );
    const ch = notifyChannel();
    setResult({
      notify: out.notified ? 'ok'
        : ch === 'granted' ? 'denied'
        : ch === 'unsupported' ? 'unsupported' : ch,
      tab: out.tabAlarmed,
      sound,
    });

    clearTimeout(timer.current);
    timer.current = setTimeout(() => { clearAlert(); setRunning(false); }, HOLD_MS);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button type="button" onClick={run} disabled={running}
        className="text-xs text-neutral-500 hover:text-neutral-200 underline
                   decoration-dotted underline-offset-2 disabled:opacity-50">
        {running ? '告警中…看标签页' : '测试告警'}
      </button>
      {result && <ResultLine r={result} onGrant={grant} />}
    </div>
  );

  /**
   * 当场授权。
   *
   * 必须有这个入口：通知权限原本只在「开启声音」时顺带问一次，
   * 而声音开启之后那个按钮就消失了 —— 一个声音开着、通知没授权的人
   * 再也没有地方能补上，而那恰恰是告警最需要的通道。
   */
  async function grant() {
    await requestNotificationPermission();
    run();                       // 直接重跑，让用户立刻看到结果变了没有
  }
}

function ResultLine({ r, onGrant }: { r: Result; onGrant: () => void }) {
  const ok = 'text-[#3fbf7f]';
  const warn = 'text-[#fab219]';
  return (
    <span className="text-xs flex items-center gap-2 flex-wrap">
      <span className={r.notify === 'ok' ? ok : warn}>
        {r.notify === 'ok' ? '系统通知 ✓'
          : r.notify === 'denied' ? '系统通知 ✗ 被浏览器拒绝'
          : r.notify === 'unsupported' ? '系统通知 ✗ 此浏览器不支持'
          : '系统通知 ✗ 未授权'}
      </span>
      {r.notify === 'default' && (
        <button type="button" onClick={onGrant}
          className="text-xs text-[#3fbf7f] hover:text-[#7ef2b4] underline underline-offset-2">
          去授权
        </button>
      )}
      <span className={r.tab ? ok : warn}>
        {r.tab ? '标签页告警 ✓' : '标签页告警 ✗ 没生效'}
      </span>
      <span className={r.sound === 'ok' ? ok : warn}>
        {r.sound === 'ok' ? '提示音 ✓'
          : r.sound === 'locked' ? '提示音 ✗ 还没开启'
          : r.sound === 'no-voice' ? '提示音 ✓ 但无中文语音，只有提示音'
          : '提示音 ✗ 被浏览器挂起'}
      </span>
    </span>
  );
}
