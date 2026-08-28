'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 置顶高亮。与跌幅无关 —— 有些币你盯着但它还没跌，
 * 按跌幅排序会把它冲到最底下，那正是需要这个功能的场景。
 */
export default function PinButton({ tokenId, pinned }: { tokenId: string; pinned: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(pinned);

  const toggle = async () => {
    setBusy(true);
    const next = !on;
    setOn(next);                       // 乐观更新，点下去立刻有反馈
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      if (!res.ok) { setOn(!next); return; }   // 失败回滚
      router.refresh();
    } catch {
      setOn(!next);
    } finally { setBusy(false); }
  };

  return (
    <button onClick={toggle} disabled={busy}
      title={on ? '取消置顶' : '置顶高亮'}
      aria-label={on ? '取消置顶' : '置顶高亮'}
      aria-pressed={on}
      className={`shrink-0 transition-colors disabled:opacity-50 ${
        on ? 'text-[#fab219]' : 'text-neutral-700 hover:text-neutral-500'
      }`}>
      <svg width="14" height="14" viewBox="0 0 24 24"
        fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
        strokeLinejoin="round">
        <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.3l6.5-.9z" />
      </svg>
    </button>
  );
}
