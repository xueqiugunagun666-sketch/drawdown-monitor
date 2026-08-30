'use client';

import { useState } from 'react';
import { humanAgo } from '../../lib/time.ts';

export interface WalletRow {
  id: string; chain: string; address: string; label: string | null;
  lastScannedBlock: number | null; lastScanAt: number | null; lastScanError: string | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function WalletList(
  { wallets, chains, onChange }: { wallets: WalletRow[]; chains: string[]; onChange: () => void },
) {
  const [chain, setChain] = useState(chains[0] ?? 'bsc');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/wallet/wallets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain, address, label }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) { setErr(d.error ?? '添加失败'); return; }
      setAddress(''); setLabel('');
      onChange();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    await fetch(`/api/wallet/wallets?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    onChange();
  }

  return (
    <section>
      <h2 className="text-sm text-neutral-400 mb-2">钱包地址</h2>

      <form onSubmit={add} className="flex gap-2 flex-wrap mb-3">
        <select value={chain} onChange={(e) => setChain(e.target.value)}
          className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5 text-sm text-neutral-300">
          {chains.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="0x…" required spellCheck={false}
          className="flex-1 min-w-[16rem] bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5
                     text-sm font-mono text-neutral-200 placeholder-neutral-600 focus:border-neutral-600 outline-none" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注（可选）"
          className="w-32 bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5 text-sm
                     text-neutral-300 placeholder-neutral-600 focus:border-neutral-600 outline-none" />
        <button type="submit" disabled={busy}
          className="bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded px-3 py-1.5 text-sm text-neutral-100">
          添加
        </button>
      </form>
      {err && <p className="text-sm text-[#d03b3b] mb-3">{err}</p>}

      {wallets.length === 0 ? (
        <p className="text-sm text-neutral-600">还没有钱包。加一个地址，十几分钟内会扫出持仓。</p>
      ) : (
        <ul className="space-y-1.5">
          {wallets.map((w) => (
            <li key={w.id}
              className={`rounded border px-3 py-2 text-sm ${
                w.lastScanError ? 'border-[#d03b3b]/50 bg-[#d03b3b]/5' : 'border-neutral-900 bg-neutral-950/60'
              }`}>
              {/* 窄屏用两行而不是挤在一行 —— 一行会把「主钱包」压成竖排三个字 */}
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-neutral-300 shrink-0">{short(w.address)}</span>
                <span className="text-xs text-neutral-600 shrink-0">{w.chain}</span>
                {w.label && <span className="text-xs text-neutral-500 truncate">{w.label}</span>}
                <button type="button" onClick={() => void remove(w.id)}
                  className="ml-auto text-xs text-neutral-600 hover:text-[#d03b3b] shrink-0">删除</button>
              </div>
              <div className="text-xs text-neutral-600 mt-0.5">
                {w.lastScanAt ? `${humanAgo(w.lastScanAt)}扫描` : '尚未扫描'}
                {w.lastScannedBlock !== null && ` · 区块 ${w.lastScannedBlock.toLocaleString()}`}
              </div>
              {/* 扫描失败必须显式暴露，不能只写进日志 */}
              {w.lastScanError && (
                <p className="text-xs text-[#d03b3b] mt-1 break-all">扫描失败：{w.lastScanError}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
