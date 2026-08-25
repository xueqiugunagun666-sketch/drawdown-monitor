'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  tokenId: string;
  symbol: string | null;
  note: string | null;
  frozen: boolean;
  enabled: boolean;
}

export default function TokenActions({ tokenId, symbol, note, frozen, enabled }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? `HTTP ${res.status}`); return false; }
      router.refresh();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally { setBusy(false); }
  };

  const remove = async () => {
    // 删除会连带清掉该代币的 candle / ATH / 报警历史，值得确认一次
    if (!confirm(`删除 ${symbol ?? tokenId}？\n\n它的历史 K 线、ATH 状态与报警记录都会一并删除，不可撤销。`)) return;
    setBusy(true); setErr('');
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div className="mt-1">
        <input
          value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') { void patch({ note: draft }).then((ok) => ok && setEditing(false)); }
            if (e.key === 'Escape') { setDraft(note ?? ''); setEditing(false); setErr(''); }
          }}
          className="w-full rounded bg-neutral-900 border border-neutral-700 px-2 py-1 text-xs
                     focus:outline-none focus:border-neutral-500"
        />
        <div className="flex gap-2 mt-1 text-xs">
          <button disabled={busy}
            onClick={() => void patch({ note: draft }).then((ok) => ok && setEditing(false))}
            className="text-sky-400 hover:text-sky-300 disabled:opacity-40">保存</button>
          <button onClick={() => { setDraft(note ?? ''); setEditing(false); setErr(''); }}
            className="text-neutral-500 hover:text-neutral-300">取消</button>
        </div>
        {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
      </div>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex gap-2 text-xs text-neutral-600">
        <button onClick={() => setEditing(true)} className="hover:text-neutral-300">改备注</button>
        <button disabled={busy} onClick={() => void patch({ frozen: !frozen })}
          className="hover:text-neutral-300 disabled:opacity-40">
          {frozen ? '解冻' : '冻结'}
        </button>
        <button disabled={busy} onClick={() => void patch({ enabled: !enabled })}
          className="hover:text-neutral-300 disabled:opacity-40">
          {enabled ? '停用' : '启用'}
        </button>
        <button disabled={busy} onClick={remove} className="hover:text-red-400 disabled:opacity-40">删除</button>
      </div>
      {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
    </div>
  );
}
