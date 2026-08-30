'use client';

import { useEffect, useState } from 'react';
import {
  unlockAudio, soundStatus, requestNotificationPermission, playPumpSound, type SoundStatus,
} from '../lib/pumpSound.ts';

/**
 * 声音与通知的开关。
 *
 * 未开启时显示醒目横幅，不是一个安静的小图标 —— 用户以为开着、
 * 实际没声音，是这个功能最危险的失效方式（第 4 条铁律）。
 */
export default function SoundToggle() {
  const [status, setStatus] = useState<SoundStatus>('locked');
  const [notify, setNotify] = useState<NotificationPermission>('default');

  useEffect(() => {
    setStatus(soundStatus());
    if (typeof Notification !== 'undefined') setNotify(Notification.permission);
  }, []);

  async function enable() {
    setStatus(await unlockAudio());
    setNotify(await requestNotificationPermission());
  }

  if (status === 'ready') {
    return (
      <div className="flex items-center gap-3 text-xs text-neutral-500">
        <span className="text-[#3fbf7f]">● 声音已开启</span>
        {notify !== 'granted' && (
          <span className="text-[#fab219]">系统通知未授权，切到别的标签页时看不到提示</span>
        )}
        <button type="button" onClick={() => playPumpSound(5)}
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
            ? '浏览器拒绝了音频播放，检查站点权限设置'
            : '暴涨时不会有任何提示音。浏览器要求先点一下才允许出声。'}
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
