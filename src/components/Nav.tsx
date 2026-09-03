import Link from 'next/link';
import UserBadge from './UserBadge.tsx';
import { currentActor } from '../lib/accountAuthServer.ts';

const LINKS: Array<[href: string, label: string]> = [
  ['/', '看板'],
  ['/add', '加币'],
  ['/calendar', '日历'],
  ['/alerts', '报警'],
  ['/wallet', '钱包'],
  ['/trash', '群聊淘金'],
  ['/settings', '设置'],
];

/**
 * @param showBadge 是否显示账号名。钱包登录页要关掉 ——
 *   这块是共享看板用的，和下面的「用户名」摆在同一屏容易看混。
 */
export default async function Nav({ current, showBadge = true }: { current: string; showBadge?: boolean }) {
  const actor = await currentActor();
  return (
    <nav className="flex items-center gap-1 mb-5 text-sm">
      {/* 窄屏横向滚动，不折行 —— 折行会把「加币」拆成上下两个字 */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none -mx-1 px-1">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href}
          className={`px-3 py-1.5 rounded whitespace-nowrap shrink-0 ${
            // 烫金只用在这一处：整站唯一的金色，才有"特别"的意思。
            // 到处都金就等于没有重点，页面正文一律保持常规配色
            href === '/trash' ? `foil ${href === current ? 'bg-neutral-800' : 'hover:brightness-110'}`
            : href === current ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-500 hover:text-neutral-300'
          }`}>
          {label}
        </Link>
      ))}
      </div>
      {showBadge && (
        <div className="ml-auto shrink-0">
          <UserBadge name={actor?.name ?? null} isAdmin={actor?.isAdmin ?? false} />
        </div>
      )}
    </nav>
  );
}
