'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CURRENT_VERSION } from '../lib/changelog.ts';

const SEEN_KEY = 'changelog_seen_version';

/**
 * 右下角的版本按钮。
 *
 * 有新版本时显示一个小圆点，点进去看过就不再显示 ——
 * 已读状态存在本地浏览器，不占服务器也不需要账号。
 * 读写都包 try/catch：无痕模式与禁用站点数据的浏览器会直接抛错。
 */
export default function ChangelogButton() {
  const pathname = usePathname();
  const [unread, setUnread] = useState(false);

  useEffect(() => {
    try {
      setUnread(localStorage.getItem(SEEN_KEY) !== CURRENT_VERSION);
    } catch {
      setUnread(false);      // 读不到就当已读，不要平白挂个红点
    }
  }, []);

  useEffect(() => {
    if (pathname !== '/changelog') return;
    try {
      localStorage.setItem(SEEN_KEY, CURRENT_VERSION);
    } catch { /* 无痕模式，忽略 */ }
    setUnread(false);
  }, [pathname]);

  // 已经在更新记录页上就不用再显示了
  if (pathname === '/changelog') return null;

  return (
    <Link
      href="/changelog"
      title="更新记录"
      className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5
                 rounded-full border border-neutral-800 bg-neutral-950/90 backdrop-blur
                 px-3 py-1.5 text-xs text-neutral-500
                 hover:text-neutral-200 hover:border-neutral-700 transition-colors
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500"
    >
      <span className="tabular-nums">{CURRENT_VERSION}</span>
      {unread && <span className="h-1.5 w-1.5 rounded-full bg-[#3fbf7f]" aria-label="有新更新" />}
    </Link>
  );
}
