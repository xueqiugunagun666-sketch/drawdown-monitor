'use client';

import { useState } from 'react';

export default function AccountForm() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await fetch(`/api/account/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = (await res.json()) as { error?: string; name?: string };
      if (!res.ok) { setErr(data.error ?? '失败了'); return; }

      // 接口返回成功不等于会话真的生效 —— 浏览器可能拦了 Cookie。
      // 那种情况下直接跳转会被中间件弹回登录页，表现就是"什么都没发生"，
      // 而用户完全看不出发生了什么。所以先拿一个需要鉴权的接口验一下
      const verify = await fetch('/api/wallet/wallets');
      if (!verify.ok) {
        setErr(
          `${mode === 'register' ? '账号已创建' : '密码正确'}，但登录状态没保持住。` +
          '多半是浏览器拦了本站 Cookie —— 检查一下隐私设置，或者换个浏览器/关掉无痕模式。',
        );
        return;
      }

      setOk(`${mode === 'register' ? '注册成功' : '登录成功'}，正在进入…`);
      // 用整页跳转而不是 router.push：
      //   1. router.push 后紧跟 router.refresh 会互相打断
      //   2. 软跳转走客户端路由缓存，而缓存里可能存着"未登录时 /wallet
      //      被弹回登录页"那个结果，于是跳了等于没跳
      // 登录状态刚变，整页重来最干净，也最不容易出玄学问题
      window.location.href = '/wallet';
    } catch {
      setErr('网络错误，检查一下连接');
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
        {err && <p className="text-sm text-[#d03b3b] leading-relaxed">{err}</p>}
        {ok && <p className="text-sm text-[#3fbf7f]">{ok}</p>}
        <button type="submit" disabled={busy}
          className="w-full bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50
                     rounded px-3 py-2 text-sm text-neutral-100">
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
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
