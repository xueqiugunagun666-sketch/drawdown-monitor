'use client';

import { useState } from 'react';

/**
 * 每人自己的小额阈值。
 *
 * 放在持仓表头上而不是设置页：这里能立刻看见效果（列表当场变短），
 * 而设置页上的那些是全局规则、只有管理员能动，不是一类东西。
 */
export default function ValueFilter(
  { value, onSave }: { value: number; onSave: (v: number) => Promise<string | null> },
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <button type="button"
        onClick={() => { setDraft(String(value)); setErr(null); setEditing(true); }}
        className="meta-label hover:text-neutral-300 underline decoration-dotted underline-offset-2">
        小额阈值 ${value}
      </button>
    );
  }

  const save = async () => {
    const n = Number(draft.trim());
    // 空着不当作 0 —— 那是"全都要"，和"我没想好"不是一回事
    if (draft.trim() === '' || !Number.isFinite(n)) { setErr('要填一个数字'); return; }
    setSaving(true);
    const e = await onSave(n);
    setSaving(false);
    if (e) { setErr(e); return; }
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="meta-label">小额阈值 $</span>
      <input
        autoFocus value={draft} inputMode="decimal"
        onChange={(e) => { setDraft(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label="小额阈值（美元）"
        className="w-20 bg-neutral-950 border border-neutral-800 rounded px-2 py-1
                   text-xs text-neutral-200 tabular-nums outline-none focus:border-neutral-600"
      />
      <button type="button" onClick={() => void save()} disabled={saving}
        className="text-xs text-[#3fbf7f] hover:text-[#7ef2b4] disabled:opacity-50">
        {saving ? '…' : '保存'}
      </button>
      <button type="button" onClick={() => setEditing(false)}
        className="text-xs text-neutral-600 hover:text-neutral-400">取消</button>
      {/* 低于这个数的币不报警也不显示 —— 必须说清楚，否则用户会以为币丢了 */}
      {err
        ? <span className="text-xs text-[#d03b3b]">{err}</span>
        : <span className="text-xs text-neutral-600">低于此值的不报警，列表里折叠起来</span>}
    </div>
  );
}
