'use client';

import { useState } from 'react';
import { humanAgo } from '../../lib/time.ts';

export interface WalletRow {
  id: string; chain: string; address: string; label: string | null;
  lastScannedBlock: number | null; lastScanAt: number | null; lastScanError: string | null;
}

export const WALLET_LABEL_MAX_LENGTH = 40;

/** 列表编辑框的本地归一化；服务端还会再次校验，不能把前端当权限边界。 */
export function normalizeWalletLabelDraft(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, WALLET_LABEL_MAX_LENGTH) : null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * 按地址归组。底层每条链一行（各链扫描水位必须分开存），
 * 但对人来说"同一个地址"就是一个钱包，不该显示成四个。
 */
export interface WalletGroup {
  address: string;
  label: string | null;
  chains: WalletRow[];
}

export function groupByAddress(rows: WalletRow[]): WalletGroup[] {
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
      className={failed ? 'badge-fired' : scanned ? 'badge-quiet' : 'badge-quiet opacity-60'}>
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
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [labelBusy, setLabelBusy] = useState(false);
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
        text: `已在 ${d.added?.join(' / ')} 上加入扫描队列${
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

  function startEdit(addr: string, current: string | null) {
    setEditingAddress(addr);
    setDraftLabel(current ?? '');
    setMsg(null);
  }

  async function saveLabel(addr: string) {
    setLabelBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/wallet/wallets', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: addr, label: normalizeWalletLabelDraft(draftLabel) ?? '' }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMsg({ kind: 'err', text: d.error ?? '备注保存失败' });
        return;
      }
      setEditingAddress(null);
      setMsg({ kind: 'ok', text: draftLabel.trim() ? '备注已保存' : '备注已清空' });
      onChange();
    } catch {
      setMsg({ kind: 'err', text: '备注保存失败，检查网络' });
    } finally { setLabelBusy(false); }
  }

  return (
    <section>
      <h2 className="text-sm text-neutral-400 mb-2">钱包地址</h2>

      <form onSubmit={add} className="flex gap-2 flex-wrap mb-2">
        <input value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="EVM 0x… 或 Solana 地址" required spellCheck={false}
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
        EVM 地址会同时监控 ethereum / bsc / base / robinhood；Solana 地址只监控 solana。
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
                className={`rounded-lg px-3 py-2.5 text-sm border ${
                  errs.length > 0 ? 'border-[#d03b3b]/50 bg-[#d03b3b]/8' : 'surface'
                }`}>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-neutral-300 shrink-0">{short(g.address)}</span>
                  {editingAddress === g.address ? (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <input
                        value={draftLabel}
                        maxLength={WALLET_LABEL_MAX_LENGTH}
                        onChange={(e) => setDraftLabel(e.target.value.slice(0, WALLET_LABEL_MAX_LENGTH))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveLabel(g.address);
                          if (e.key === 'Escape') setEditingAddress(null);
                        }}
                        aria-label="钱包地址备注"
                        autoFocus
                        className="w-28 min-w-0 bg-neutral-950 border border-neutral-700 rounded px-1.5 py-0.5
                                   text-xs text-neutral-200 outline-none focus:border-neutral-500"
                      />
                      <button type="button" disabled={labelBusy} onClick={() => void saveLabel(g.address)}
                        className="text-xs text-[#3fbf7f] hover:text-[#7ef2b4] disabled:opacity-50 shrink-0">
                        保存
                      </button>
                      <button type="button" disabled={labelBusy} onClick={() => setEditingAddress(null)}
                        className="text-xs text-neutral-600 hover:text-neutral-400 disabled:opacity-50 shrink-0">
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      {g.label && <span className="text-xs text-neutral-500 truncate">备注：{g.label}</span>}
                      <button type="button" onClick={() => startEdit(g.address, g.label)}
                        className="text-xs text-neutral-600 hover:text-neutral-300 shrink-0">
                        {g.label ? '编辑' : '添加备注'}
                      </button>
                    </>
                  )}
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
