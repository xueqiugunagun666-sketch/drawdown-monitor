import Link from 'next/link';
import UserBadge from './UserBadge.tsx';

const LINKS: Array<[href: string, label: string]> = [
  ['/', '看板'],
  ['/add', '加币'],
  ['/calendar', '日历'],
  ['/alerts', '报警'],
  ['/settings', '设置'],
];

export default function Nav({ current }: { current: string }) {
  return (
    <nav className="flex items-center gap-1 mb-5 text-sm">
      {/* 窄屏横向滚动，不折行 —— 折行会把「加币」拆成上下两个字 */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none -mx-1 px-1">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href}
          className={`px-3 py-1.5 rounded whitespace-nowrap shrink-0 ${
            href === current ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
          }`}>
          {label}
        </Link>
      ))}
      </div>
      <div className="ml-auto shrink-0">
        <UserBadge />
      </div>
    </nav>
  );
}
