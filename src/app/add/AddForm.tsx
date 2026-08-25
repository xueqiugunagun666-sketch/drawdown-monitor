'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ResolvedItem {
  raw: string; ok: true; id: string; chain: string; address: string;
  symbol: string | null; name: string | null; liquidityUsd: number;
  poolCount: number; alreadyAdded: boolean;
}
interface FailedItem { raw: string; ok: false; error: string }
type Item = ResolvedItem | FailedItem;

export default function AddForm() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const resolve = async () => {
    setBusy(true); setError(''); setDone(''); setItems(null);
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setItems(data.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!items) return;
    const ready = items.filter((i): i is ResolvedItem => i.ok && !i.alreadyAdded);
    const missing = ready.filter((i) => !(notes[i.id] ?? '').trim());
    if (missing.length > 0) {
      setError(`还有 ${missing.length} 个没填备注 —— 报警时最需要回忆的就是当初为什么关注它`);
      return;
    }
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tokens: ready.map((i) => ({ chain: i.chain, address: i.address, note: notes[i.id] })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setDone(`已添加 ${data.count} 个。worker 下一轮取价后会自动开始回填历史。`);
      setItems(null); setText(''); setNotes({});
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const okItems = items?.filter((i): i is ResolvedItem => i.ok) ?? [];
  const badItems = items?.filter((i): i is FailedItem => !i.ok) ?? [];
  const addable = okItems.filter((i) => !i.alreadyAdded);

  return (
    <div className="max-w-3xl">
      <label className="block text-sm text-neutral-400 mb-2">
        粘贴地址或链接，一行一个
      </label>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)}
        rows={5} spellCheck={false}
        placeholder={'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263\nbase:0x532f27101965dd16442e59d40670faf5ebb142e4\nhttps://dexscreener.com/solana/5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9'}
        className="w-full rounded bg-neutral-900 border border-neutral-800 p-3 text-sm font-mono
                   focus:outline-none focus:border-neutral-600"
      />
      <p className="text-xs text-neutral-600 mt-1">
        支持纯地址、<code>chain:address</code>、DexScreener / GeckoTerminal / GMGN 链接。
        EVM 地址会自动探测属于哪条链。
      </p>

      <button onClick={resolve} disabled={busy || !text.trim()}
        className="mt-3 px-4 py-2 rounded bg-neutral-800 text-sm hover:bg-neutral-700 disabled:opacity-40">
        {busy ? '识别中…' : '识别'}
      </button>

      {error && (
        <div className="mt-4 p-3 rounded border border-red-900 bg-red-950/40 text-sm text-red-300">{error}</div>
      )}
      {done && (
        <div className="mt-4 p-3 rounded border border-green-900 bg-green-950/30 text-sm text-green-300">{done}</div>
      )}

      {badItems.length > 0 && (
        <div className="mt-4 p-3 rounded border border-amber-900 bg-amber-950/30 text-xs text-amber-300">
          <div className="font-medium mb-1">这几行没能识别</div>
          {badItems.map((b, i) => (
            <div key={i} className="font-mono">{b.raw.slice(0, 60)} — {b.error}</div>
          ))}
        </div>
      )}

      {okItems.length > 0 && (
        <div className="mt-5">
          <h2 className="text-sm font-medium mb-2">识别结果（{okItems.length}）</h2>
          <div className="space-y-3">
            {okItems.map((it) => (
              <div key={it.id} className={`p-3 rounded border ${
                it.alreadyAdded ? 'border-neutral-800 bg-neutral-900/40 opacity-60' : 'border-neutral-800'
              }`}>
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-medium">{it.symbol ?? '(无符号)'}</span>
                  <span className="text-xs text-neutral-500">{it.chain}</span>
                  <span className="text-xs text-neutral-600">
                    {it.poolCount} 池 · ${Math.round(it.liquidityUsd).toLocaleString()}
                  </span>
                  {it.alreadyAdded && <span className="text-xs text-amber-500">已在清单中</span>}
                </div>
                <div className="text-xs text-neutral-600 font-mono mt-1 break-all">{it.address}</div>
                {!it.alreadyAdded && (
                  <input
                    value={notes[it.id] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [it.id]: e.target.value })}
                    placeholder="备注（必填）：为什么关注它"
                    className="mt-2 w-full rounded bg-neutral-900 border border-neutral-800 px-2 py-1.5 text-sm
                               focus:outline-none focus:border-neutral-600"
                  />
                )}
              </div>
            ))}
          </div>

          {addable.length > 0 && (
            <button onClick={submit} disabled={busy}
              className="mt-4 px-4 py-2 rounded bg-sky-800 text-sm hover:bg-sky-700 disabled:opacity-40">
              {busy ? '添加中…' : `添加 ${addable.length} 个`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
