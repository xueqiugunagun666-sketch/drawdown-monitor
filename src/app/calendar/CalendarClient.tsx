'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import EventForm, { emptyDraft, type EventDraft } from './EventForm.tsx';
import { CATEGORY_LABEL, type Category } from '../../lib/eventInput.ts';
import { formatInZone, humanUntil, zoneAbbr, DISPLAY_TZ, toInputValue } from '../../lib/timezone.ts';

export interface EventItem {
  id: string; title: string; atTs: number; inputTz: string;
  category: string | null; priority: string; note: string | null;
  links: string | null; remindOffsets: string; createdBy: string | null; enabled: number;
}

const PRIORITY_STYLE: Record<string, string> = {
  high: 'border-l-2 border-l-red-500/70',
  normal: 'border-l-2 border-l-neutral-700',
  low: 'border-l-2 border-l-neutral-800',
};

function parseLinks(json: string | null): Array<{ label: string; url: string }> {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v as Array<{ label: string; url: string }> : [];
  } catch { return []; }
}

function toDraft(e: EventItem): EventDraft {
  return {
    id: e.id, title: e.title, at: toInputValue(e.atTs, e.inputTz), inputTz: e.inputTz,
    category: e.category ?? 'other', priority: e.priority, note: e.note ?? '',
    links: [...parseLinks(e.links), { label: '', url: '' }],
    remindOffsets: (() => { try { return JSON.parse(e.remindOffsets) as number[]; } catch { return [0]; } })(),
  };
}

export default function CalendarClient({ events, showPast }: { events: EventItem[]; showPast: boolean }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const now = Math.floor(Date.now() / 1000);

  const remove = async (e: EventItem) => {
    if (!confirm(`删除「${e.title}」？`)) return;
    await fetch(`/api/events/${e.id}`, { method: 'DELETE' });
    router.refresh();
  };

  const toggle = async (e: EventItem) => {
    await fetch(`/api/events/${e.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: e.enabled !== 1 }),
    });
    router.refresh();
  };

  const shown = filter === 'all' ? events : events.filter((e) => (e.category ?? 'other') === filter);
  const cats = [...new Set(events.map((e) => e.category ?? 'other'))];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {!adding && (
          <button onClick={() => { setAdding(true); setEditingId(null); }}
            className="px-3 py-1.5 rounded bg-sky-800 text-sm hover:bg-sky-700">+ 添加日程</button>
        )}
        <div className="flex gap-1 text-xs ml-auto">
          <button onClick={() => setFilter('all')}
            className={`px-2 py-1 rounded ${filter === 'all' ? 'bg-neutral-800' : 'text-neutral-500 hover:text-neutral-300'}`}>
            全部
          </button>
          {cats.map((c) => (
            <button key={c} onClick={() => setFilter(c)}
              className={`px-2 py-1 rounded ${filter === c ? 'bg-neutral-800' : 'text-neutral-500 hover:text-neutral-300'}`}>
              {CATEGORY_LABEL[c as Category] ?? c}
            </button>
          ))}
          <a href={showPast ? '/calendar' : '/calendar?past=1'}
            className="px-2 py-1 rounded text-neutral-500 hover:text-neutral-300">
            {showPast ? '只看将来' : '含已过去'}
          </a>
        </div>
      </div>

      {adding && (
        <div className="mb-4">
          <EventForm initial={emptyDraft()} onDone={() => setAdding(false)} />
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-neutral-600">还没有日程。</p>
      ) : (
        <div className="space-y-2">
          {shown.map((e) => {
            if (editingId === e.id) {
              return (
                <div key={e.id}>
                  <EventForm initial={toDraft(e)} onDone={() => setEditingId(null)} />
                </div>
              );
            }
            const past = e.atTs < now;
            const links = parseLinks(e.links);
            return (
              <div key={e.id}
                className={`rounded bg-neutral-950 p-3 ${PRIORITY_STYLE[e.priority] ?? ''} ${
                  past || e.enabled !== 1 ? 'opacity-50' : ''
                }`}>
                <div className="flex flex-wrap items-baseline gap-2">
                  {e.priority === 'high' && <span className="text-xs text-red-400">重要</span>}
                  <span className="font-medium">{e.title}</span>
                  {e.category && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400">
                      {CATEGORY_LABEL[e.category as Category] ?? e.category}
                    </span>
                  )}
                  {e.enabled !== 1 && <span className="text-xs text-neutral-600">已停用</span>}
                </div>

                <div className="mt-1 text-sm tabular-nums">
                  {formatInZone(e.atTs, DISPLAY_TZ)}
                  <span className="text-xs text-neutral-500 ml-1">北京时间</span>
                  <span className={`ml-3 text-xs ${past ? 'text-neutral-600' : 'text-sky-400'}`}>
                    {humanUntil(e.atTs, now)}
                  </span>
                </div>
                {e.inputTz !== DISPLAY_TZ && (
                  <div className="text-xs text-neutral-600">
                    原始 {formatInZone(e.atTs, e.inputTz)} {e.inputTz} ({zoneAbbr(e.inputTz, e.atTs)})
                  </div>
                )}

                {e.note && <div className="text-xs text-amber-500/90 mt-1">{e.note}</div>}

                {links.length > 0 && (
                  <div className="flex flex-wrap gap-3 mt-2">
                    {links.map((l, i) => (
                      <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-sky-400 hover:underline">
                        {l.label || new URL(l.url).hostname}
                      </a>
                    ))}
                  </div>
                )}

                <div className="flex gap-3 mt-2 text-xs text-neutral-600">
                  <button onClick={() => { setEditingId(e.id); setAdding(false); }}
                    className="hover:text-neutral-300">编辑</button>
                  <button onClick={() => void toggle(e)} className="hover:text-neutral-300">
                    {e.enabled === 1 ? '停用' : '启用'}
                  </button>
                  <button onClick={() => void remove(e)} className="hover:text-red-400">删除</button>
                  {e.createdBy && <span className="ml-auto">由 {e.createdBy} 添加</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
