'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 当前署名。点一下可改。
 * 这是署名不是身份 —— 见 src/lib/user.ts 的说明。
 */
export default function UserBadge() {
  const router = useRouter();
  const [name, setName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch('/api/user')
      .then((r) => r.json())
      .then((d: { name: string | null }) => { setName(d.name); setDraft(d.name ?? ''); })
      .catch(() => { /* 拿不到就当未设置 */ })
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    const res = await fetch('/api/user', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: draft }),
    });
    if (!res.ok) return;
    const d = await res.json() as { name: string };
    setName(d.name); setEditing(false);
    router.refresh();
  };

  if (!loaded) return null;

  if (editing || !name) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-neutral-500">署名</span>
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          placeholder="你的名字"
          className="w-24 rounded bg-neutral-900 border border-neutral-700 px-2 py-1
                     focus:outline-none focus:border-neutral-500"
        />
        <button onClick={() => void save()} disabled={!draft.trim()}
          className="text-sky-400 hover:text-sky-300 disabled:opacity-40">保存</button>
        {name && <button onClick={() => { setDraft(name); setEditing(false); }}
          className="text-neutral-500 hover:text-neutral-300">取消</button>}
      </div>
    );
  }

  return (
    <button onClick={() => setEditing(true)}
      className="text-xs text-neutral-500 hover:text-neutral-300"
      title="点击修改署名">
      {name}
    </button>
  );
}
