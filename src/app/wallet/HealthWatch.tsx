'use client';

import { useEffect, useRef, useState } from 'react';
import {
  step, activeIssues, initialWatchState, describeIssue,
  healthIssuesForSignals, BUSINESS_HEARTBEAT_TIMEOUT_SECONDS,
  type HealthIssue, type WatchState,
} from '../../lib/alertHealth.ts';
import { popup, clearAlert } from '../../lib/healthAlert.ts';
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
export { BUSINESS_HEARTBEAT_TIMEOUT_SECONDS };

interface HealthWatchProps {
  streamConnected: boolean;
  businessHeartbeatAt: number | null;
  backendDown: boolean;
  alertReadDown: boolean;
}

export default function HealthWatch({
  streamConnected, businessHeartbeatAt, backendDown, alertReadDown,
}: HealthWatchProps) {
  const state = useRef<WatchState>(initialWatchState());
  /** 用 ref 读最新的外部状态，免得每次变化都重建定时器 */
  const connected = useRef(streamConnected);
  const connectedSince = useRef<number | null>(streamConnected ? Math.floor(Date.now() / 1000) : null);
  const heartbeatAt = useRef(businessHeartbeatAt);
  const backendFailed = useRef(backendDown);
  const alertReadFailed = useRef(alertReadDown);
  const audioOk = useRef(soundStatus() === 'ready');
  const [visibleIssues, setVisibleIssues] = useState<HealthIssue[]>([]);
  const [popupFailed, setPopupFailed] = useState(false);

  useEffect(() => {
    if (streamConnected && !connected.current) connectedSince.current = Math.floor(Date.now() / 1000);
    if (!streamConnected) connectedSince.current = null;
    connected.current = streamConnected;
  }, [streamConnected]);
  useEffect(() => { heartbeatAt.current = businessHeartbeatAt; }, [businessHeartbeatAt]);
  useEffect(() => { backendFailed.current = backendDown; }, [backendDown]);
  useEffect(() => { alertReadFailed.current = alertReadDown; }, [alertReadDown]);
  useEffect(() => watchSoundStatus((s) => { audioOk.current = s === 'ready'; }), []);

  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const present = healthIssuesForSignals({
        audioReady: audioOk.current,
        streamConnected: connected.current,
        streamConnectedSince: connectedSince.current,
        businessHeartbeatAt: heartbeatAt.current,
        backendDown: backendFailed.current,
        alertReadDown: alertReadFailed.current,
      }, now);

      const r = step(state.current, present, now);
      state.current = r.state;

      for (const issue of r.notify) {
        const d = describeIssue(issue);
        if (!popup(d.title, d.body, `health-${issue}`)) setPopupFailed(true);
      }

      // 标签页告警跟着"当前确实有问题"走，不跟着弹窗走 ——
      // 弹窗只在变化时发一次，而标签页要一直挂着直到恢复
      const active = activeIssues(state.current, now);
      setVisibleIssues((prev) => prev.join('|') === active.join('|') ? prev : active);
      if (active.length === 0) setPopupFailed(false);
      setTabAlarm(active.length === 0 ? null : describeIssue(active[0]!).title);
    };

    tick();
    const t = setInterval(tick, 1000);
    return () => {
      clearInterval(t);
      // 用 clearAlert 而不是 setTabAlarm(null)：后者在「测试告警」的占用期内
      // 会被挡住，图标就留在告警状态了 —— 而这一栏只有钱包页挂着看门狗，
      // 切到别的页面之后没人再来清它
      clearAlert();
    };
  }, []);

  if (visibleIssues.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg border-2 border-[#d03b3b]/70 bg-[#d03b3b]/10 px-3 py-2.5">
      <p className="text-sm font-semibold text-[#ffb1b1]">报警链路异常</p>
      <ul className="mt-1 space-y-1 text-xs text-[#f5c0c0]">
        {visibleIssues.map((issue) => {
          const d = describeIssue(issue);
          return <li key={issue}><span className="font-medium">{d.title}：</span>{d.body}</li>;
        })}
      </ul>
      {popupFailed && (
        <p className="mt-1.5 text-xs font-medium text-[#ffb1b1]">
          系统弹窗也没有成功创建；当前页面和标签页标题会持续显示故障。
        </p>
      )}
    </div>
  );
}
