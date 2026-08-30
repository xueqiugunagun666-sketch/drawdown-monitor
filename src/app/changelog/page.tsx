import Link from 'next/link';
import Nav from '../../components/Nav.tsx';
import { RELEASES, type Change } from '../../lib/changelog.ts';

export const dynamic = 'force-dynamic';

/**
 * 三类改动用文字标签区分，不靠颜色单独承载信息 ——
 * 与 severity.ts 里"颜色从不单独承载信息"是同一条原则。
 */
const KIND: Record<Change['kind'], { label: string; cls: string }> = {
  new:    { label: '新增', cls: 'text-[#3fbf7f] border-[#3fbf7f]/30 bg-[#3fbf7f]/10' },
  fix:    { label: '修复', cls: 'text-[#d03b3b] border-[#d03b3b]/30 bg-[#d03b3b]/10' },
  change: { label: '改动', cls: 'text-neutral-400 border-neutral-700 bg-neutral-800/50' },
};

export default function ChangelogPage() {
  return (
    <main className="mx-auto max-w-3xl p-4">
      <Nav current="/changelog" />

      <header className="mb-8">
        <h1 className="text-lg text-neutral-200">更新记录</h1>
        <p className="text-sm text-neutral-500 mt-1">
          每次改动都写在这里。想知道报警是怎么判的，看
          <Link href="/how" className="text-neutral-400 hover:text-neutral-200 underline underline-offset-2 mx-1">
            判定原理
          </Link>
          。
        </p>
      </header>

      <div className="space-y-10">
        {RELEASES.map((r, i) => (
          <section key={r.version}>
            <div className="flex items-baseline gap-3 pb-2 mb-3 border-b border-neutral-900">
              <h2 className="text-base font-medium text-neutral-200 tabular-nums">{r.version}</h2>
              <span className="text-sm text-neutral-400">{r.headline}</span>
              <span className="ml-auto text-xs text-neutral-600 tabular-nums shrink-0">{r.date}</span>
              {i === 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded border border-[#3fbf7f]/30
                                 bg-[#3fbf7f]/10 text-[#3fbf7f] shrink-0">
                  最新
                </span>
              )}
            </div>

            <ul className="space-y-3">
              {r.changes.map((c) => (
                <li key={c.title} className="flex gap-3">
                  <span className={`shrink-0 mt-0.5 text-xs px-1.5 py-0.5 rounded border h-fit ${KIND[c.kind].cls}`}>
                    {KIND[c.kind].label}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-neutral-200">{c.title}</p>
                    {c.detail && (
                      <p className="text-sm text-neutral-500 mt-1 leading-relaxed">{c.detail}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-12 pt-4 border-t border-neutral-900 text-xs text-neutral-600">
        有问题或者想改什么，直接说。
      </p>
    </main>
  );
}
