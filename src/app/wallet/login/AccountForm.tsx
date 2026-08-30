'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AccountForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/account/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) { setErr(data.error ?? '失败了'); return; }
      router.push('/wallet');
      router.refresh();
    } catch {
      setErr('网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <h1 className="text-lg text-neutral-200 mb-1">钱包异动监控</h1>
      <p className="text-sm text-neutral-500 mb-5 leading-relaxed">
        这一区需要单独的个人账号。持仓按账号隔离，
        <span className="text-neutral-400">其他人看不到你的钱包和持仓</span>。
      </p>

      <div className="flex gap-1 mb-4 text-sm">
        {(['login', 'register'] as const).map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setErr(null); }}
            className={`px-3 py-1.5 rounded ${
              mode === m ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
            }`}>
            {m === 'login' ? '登录' : '注册'}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="用户名" autoComplete="username" required
          className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm
                     text-neutral-200 placeholder-neutral-600 focus:border-neutral-600 outline-none"
        />
        <input
          type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'register' ? '密码（至少 8 位）' : '密码'}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required
          className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm
                     text-neutral-200 placeholder-neutral-600 focus:border-neutral-600 outline-none"
        />
        {err && <p className="text-sm text-[#d03b3b]">{err}</p>}
        <button type="submit" disabled={busy}
          className="w-full bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50
                     rounded px-3 py-2 text-sm text-neutral-100">
          {busy ? '…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
      </form>

      {mode === 'register' && (
        <p className="text-xs text-neutral-600 mt-4 leading-relaxed">
          这个密码和进站口令是两回事。进站口令是大家共用的，这个只有你自己知道。
          忘了没法找回，我这边看不到明文。
        </p>
      )}
    </div>
  );
}
