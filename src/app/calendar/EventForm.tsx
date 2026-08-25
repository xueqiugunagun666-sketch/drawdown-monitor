'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TIMEZONES, DISPLAY_TZ, zoneAbbr } from '../../lib/timezone.ts';
import { CATEGORIES, PRIORITIES, CATEGORY_LABEL, PRIORITY_LABEL } from '../../lib/eventInput.ts';

export interface EventDraft {
  id?: string;
  title: string;
  at: string;            // "YYYY-MM-DDTHH:mm"，按 inputTz 解释
  inputTz: string;
  category: string;
  priority: string;
  note: string;
  links: Array<{ label: string; url: string }>;
  remindOffsets: number[];
}

const REMIND_CHOICES: Array<[number, string]> = [
  [10080, '提前 1 周'], [1440, '提前 1 天'], [360, '提前 6 小时'],
  [60, '提前 1 小时'], [15, '提前 15 分钟'], [0, '到点'],
];

export function emptyDraft(): EventDraft {
  return {
    title: '', at: '', inputTz: DISPLAY_TZ, category: 'mint', priority: 'normal',
    note: '', links: [{ label: '', url: '' }], remindOffsets: [1440, 60, 0],
  };
}

const field = 'w-full rounded bg-neutral-900 border border-neutral-800 px-2 py-1.5 text-sm focus:outline-none focus:border-neutral-600';

export default function EventForm({ initial, onDone }: { initial: EventDraft; onDone: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<EventDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const body = {
        title: d.title, at: d.at, inputTz: d.inputTz,
        category: d.category || null, priority: d.priority, note: d.note,
        links: d.links.filter((l) => l.url.trim()),
        remindOffsets: d.remindOffsets,
      };
      const res = await fetch(d.id ? `/api/events/${d.id}` : '/api/events', {
        method: d.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? `HTTP ${res.status}`); return; }
      onDone();
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const setLink = (i: number, patch: Partial<{ label: string; url: string }>) => {
    const links = [...d.links];
    links[i] = { ...links[i]!, ...patch };
    setD({ ...d, links });
  };

  return (
    <div className="rounded border border-neutral-800 p-4 space-y-4 bg-neutral-950">
      <div>
        <label className="block text-sm mb-1">标题</label>
        <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })}
          className={field} placeholder="例如：Foo NFT 公售" autoFocus />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm mb-1">时间</label>
          <input type="datetime-local" value={d.at}
            onChange={(e) => setD({ ...d, at: e.target.value })} className={field} />
        </div>
        <div>
          <label className="block text-sm mb-1">这个时间是哪个时区的</label>
          <select value={d.inputTz} onChange={(e) => setD({ ...d, inputTz: e.target.value })} className={field}>
            {TIMEZONES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          {d.inputTz !== DISPLAY_TZ && (
            <p className="text-xs text-amber-500/80 mt-1">
              按 {zoneAbbr(d.inputTz)} 录入，列表与推送会自动换算成北京时间
            </p>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm mb-1">分类</label>
          <select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} className={field}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm mb-1">重要程度</label>
          <select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })} className={field}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm mb-1">提醒时间点</label>
        <div className="flex flex-wrap gap-2">
          {REMIND_CHOICES.map(([mins, label]) => {
            const on = d.remindOffsets.includes(mins);
            return (
              <button key={mins} type="button"
                onClick={() => setD({
                  ...d,
                  remindOffsets: on ? d.remindOffsets.filter((x) => x !== mins) : [...d.remindOffsets, mins],
                })}
                className={`px-2 py-1 rounded text-xs ${
                  on ? 'bg-sky-800 text-sky-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'
                }`}>
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-sm mb-1">链接</label>
        <div className="space-y-2">
          {d.links.map((l, i) => (
            <div key={i} className="flex gap-2">
              <input value={l.label} onChange={(e) => setLink(i, { label: e.target.value })}
                placeholder="X / OpenSea / 官网" className={`${field} w-32 flex-none`} />
              <input value={l.url} onChange={(e) => setLink(i, { url: e.target.value })}
                placeholder="https://…" className={field} />
              <button type="button" onClick={() => setD({ ...d, links: d.links.filter((_, j) => j !== i) })}
                className="text-xs text-neutral-600 hover:text-red-400 px-1">删</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setD({ ...d, links: [...d.links, { label: '', url: '' }] })}
          className="text-xs text-sky-400 hover:text-sky-300 mt-2">+ 再加一条</button>
      </div>

      <div>
        <label className="block text-sm mb-1">备注</label>
        <textarea value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })}
          rows={2} className={field} placeholder="白名单情况、价格、注意事项…" />
      </div>

      {err && <div className="p-2 rounded border border-red-900 bg-red-950/40 text-sm text-red-300">{err}</div>}

      <div className="flex gap-2">
        <button onClick={() => void submit()} disabled={busy || !d.title.trim() || !d.at}
          className="px-4 py-2 rounded bg-sky-800 text-sm hover:bg-sky-700 disabled:opacity-40">
          {busy ? '保存中…' : d.id ? '保存修改' : '添加'}
        </button>
        <button onClick={onDone} className="px-4 py-2 rounded bg-neutral-800 text-sm hover:bg-neutral-700">取消</button>
      </div>
    </div>
  );
}
