'use client';

import { useEffect, useState } from 'react';
import {
  unlockAudio, soundStatus, requestNotificationPermission, playPumpSound,
  loadVoice, currentVoiceName, watchSoundStatus, PUMP_PHRASE, ATH_PHRASE,
  type SoundStatus,
} from '../lib/pumpSound.ts';

/**
 * 声音与通知的开关。
 *
 * 未开启时显示醒目横幅，不是一个安静的小图标 —— 用户以为开着、
 * 实际没声音，是这个功能最危险的失效方式（第 4 条铁律）。
 * 没有中文语音时也要明说，而不是安静退回滴一声。
 */
export default function SoundToggle() {
  const [status, setStatus] = useState<SoundStatus>('locked');
  const [notify, setNotify] = useState<NotificationPermission>('default');
  const [voice, setVoice] = useState<string | null>(null);

  useEffect(() => {
    setStatus(soundStatus());
    if (typeof Notification !== 'undefined') setNotify(Notification.permission);
    void loadVoice().then(() => setVoice(currentVoiceName()));
  }, []);

  /**
   * 状态要**持续**盯着，不能只在加载时查一次。
   *
   * 浏览器会在后台标签页或系统休眠后挂起 AudioContext，挂起之后
   * 提示音静默地什么都不响，而这里仍然显示「声音已开启」——
   * 网页开一下午、以为在盯着其实早就哑了。开关必须自己翻回去。
   */
  // 依赖 status：开启之后要重新订阅一次，好挂上 AudioContext 自己的 statechange
  useEffect(() => watchSoundStatus(setStatus), [status]);

  async function enable() {
    setStatus(await unlockAudio());
    setVoice(currentVoiceName());
    setNotify(await requestNotificationPermission());
  }

  if (status === 'ready') {
    return (
      <div className="flex items-center gap-3 text-xs text-neutral-500 flex-wrap">
        <span className="text-[#3fbf7f]">● 声音已开启</span>
        {voice
          ? <span>暴涨播报「{PUMP_PHRASE}」，破新高播报「{ATH_PHRASE}」（{voice}）</span>
          // 没有中文语音要明说，否则用户以为会播报、实际只有滴声
          : <span className="text-[#fab219]">这台设备没有中文语音，只会响提示音，不会播报</span>}
        {notify !== 'granted' && (
          <span className="text-[#fab219]">系统通知未授权，切到别的标签页时看不到提示</span>
        )}
        <button type="button" onClick={() => playPumpSound()}
          className="text-neutral-500 hover:text-neutral-300 underline underline-offset-2">
          试听
        </button>
      </div>
    );
  }

  return (
    <div className="rounded border border-[#fab219]/40 bg-[#fab219]/10 px-3 py-2.5
                    flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm">
        <span className="text-[#fab219]">声音未开启</span>
        <span className="text-neutral-400 ml-2">
          {status === 'blocked'
            ? '浏览器把音频挂起了（切到后台或系统休眠之后常见），暴涨时不会响。点一下恢复。'
            : '暴涨时不会有任何提示。浏览器要求先点一下才允许出声。'}
        </span>
      </div>
      <button type="button" onClick={enable}
        className="shrink-0 bg-[#fab219] hover:bg-[#ffc94a] text-neutral-950
                   rounded px-3 py-1.5 text-sm font-medium">
        开启声音
      </button>
    </div>
  );
}
