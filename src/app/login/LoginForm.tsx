'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? `HTTP ${res.status}`); return; }
      router.replace('/');
      router.refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="w-full max-w-xs">
      <label className="block text-sm text-neutral-400 mb-2">口令</label>
      <input
        type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        autoFocus autoComplete="current-password"
        className="w-full rounded bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm
                   focus:outline-none focus:border-neutral-600"
      />
      {err && <div className="mt-3 text-sm text-red-400">{err}</div>}
      <button type="submit" disabled={busy || !password}
        className="mt-4 w-full px-4 py-2 rounded bg-sky-800 text-sm hover:bg-sky-700 disabled:opacity-40">
        {busy ? '验证中…' : '进入'}
      </button>
    </form>
  );
}
