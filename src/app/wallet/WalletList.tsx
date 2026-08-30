'use client';

import { useState } from 'react';
import { humanAgo } from '../../lib/time.ts';

export interface WalletRow {
  id: string; chain: string; address: string; label: string | null;
  lastScannedBlock: number | null; lastScanAt: number | null; lastScanError: string | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * 按地址归组。底层每条链一行（各链扫描水位必须分开存），
 * 但对人来说"同一个地址"就是一个钱包，不该显示成四个。
 */
function groupByAddress(rows: WalletRow[]) {
  const m = new Map<string, { address: string; label: string | null; chains: WalletRow[] }>();
  for (const r of rows) {
    const g = m.get(r.address) ?? { address: r.address, label: r.label, chains: [] };
    g.chains.push(r);
    if (!g.label && r.label) g.label = r.label;
    m.set(r.address, g);
  }
  return [...m.values()];
}

function ChainChip({ w }: { w: WalletRow }) {
  const failed = Boolean(w.lastScanError);
  const scanned = w.lastScanAt !== null;
  return (
    <span
      title={w.lastScanError ?? (scanned ? `${humanAgo(w.lastScanAt!)}扫描` : '排队中')}
      className={`px-1.5 py-0.5 rounded text-xs ${
        failed ? 'bg-[#d03b3b]/15 text-[#d03b3b]'
          : scanned ? 'bg-neutral-800 text-neutral-400'
          : 'bg-neutral-900 text-neutral-600'
      }`}>
      {w.chain}
      {failed && ' ✕'}
      {!scanned && !failed && ' …'}
    </span>
  );
}

export default function WalletList(
  { wallets, chains, onChange }: { wallets: WalletRow[]; chains: string[]; onChange: () => void },
) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = groupByAddress(wallets);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/wallet/wallets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, label }),
      });
      const d = (await res.json()) as { error?: string; added?: string[]; already?: string[] };
      if (!res.ok) { setMsg({ kind: 'err', text: d.error ?? '添加失败' }); return; }
      setAddress(''); setLabel('');
      setMsg({
        kind: 'ok',
        text: `已在 ${d.added?.join(' / ')} 上开始监控${
          d.already?.length ? `（${d.already.join(' / ')} 之前加过了）` : ''
        }`,
      });
      onChange();
    } finally { setBusy(false); }
  }

  async function remove(addr: string) {
    await fetch(`/api/wallet/wallets?address=${encodeURIComponent(addr)}`, { method: 'DELETE' });
    onChange();
  }

  return (
    <section>
      <h2 className="text-sm text-neutral-400 mb-2">钱包地址</h2>

      <form onSubmit={add} className="flex gap-2 flex-wrap mb-2">
        <input value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="0x…" required spellCheck={false}
          className="flex-1 min-w-[15rem] bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5
                     text-sm font-mono text-neutral-200 placeholder-neutral-600 focus:border-neutral-600 outline-none" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注（可选）"
          className="w-28 bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5 text-sm
                     text-neutral-300 placeholder-neutral-600 focus:border-neutral-600 outline-none" />
        <button type="submit" disabled={busy}
          className="bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 rounded px-3 py-1.5 text-sm text-neutral-100">
          添加
        </button>
      </form>
      <p className="text-xs text-neutral-600 mb-3">
        填一次就行，{chains.join(' / ')} 四条链会一起监控。
      </p>
      {msg && (
        <p className={`text-sm mb-3 ${msg.kind === 'err' ? 'text-[#d03b3b]' : 'text-[#3fbf7f]'}`}>
          {msg.text}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-neutral-600">还没有钱包。加一个地址，一分钟内开始扫描。</p>
      ) : (
        <ul className="space-y-1.5">
          {groups.map((g) => {
            const errs = g.chains.filter((c) => c.lastScanError);
            const latest = g.chains.reduce<number | null>(
              (m, c) => (c.lastScanAt && (m === null || c.lastScanAt > m) ? c.lastScanAt : m), null);
            return (
              <li key={g.address}
                className={`rounded border px-3 py-2 text-sm ${
                  errs.length > 0 ? 'border-[#d03b3b]/50 bg-[#d03b3b]/5' : 'border-neutral-900 bg-neutral-950/60'
                }`}>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-neutral-300 shrink-0">{short(g.address)}</span>
                  {g.label && <span className="text-xs text-neutral-500 truncate">{g.label}</span>}
                  <button type="button" onClick={() => void remove(g.address)}
                    className="ml-auto text-xs text-neutral-600 hover:text-[#d03b3b] shrink-0">删除</button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                  {g.chains.map((c) => <ChainChip key={c.id} w={c} />)}
                  <span className="ml-auto text-xs text-neutral-600">
                    {latest ? `${humanAgo(latest)}扫描` : '排队中'}
                  </span>
                </div>
                {/* 扫描失败必须显式暴露，不能只写进日志 */}
                {errs.map((c) => (
                  <p key={c.id} className="text-xs text-[#d03b3b] mt-1 break-all">
                    {c.chain} 扫描失败：{c.lastScanError}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
