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
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href}
          className={`px-3 py-1.5 rounded ${
            href === current ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
          }`}>
          {label}
        </Link>
      ))}
      <div className="ml-auto">
        <UserBadge />
      </div>
    </nav>
  );
}
