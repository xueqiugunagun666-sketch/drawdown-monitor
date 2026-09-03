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
      /**
       * 原本用的是 meta-label（10px + neutral-600），跟背景几乎一个色 ——
       * 用户反馈根本看不见。做成一个有边框的小控件：一眼认得出是能点的，
       * 数字用高对比亮色单独拎出来，因为"阈值是多少"才是要一眼读到的信息。
       *
       * 颜色特意避开绿色和琥珀色：那两个在这个页面里分别是"监控中/成功"
       * 与"出问题了"，一个普通设置借用它们会读成状态。
       */
      <button type="button"
        onClick={() => { setDraft(String(value)); setErr(null); setEditing(true); }}
        className="inline-flex items-center gap-1.5 text-[13px] rounded px-2 py-1
                   border border-neutral-800 bg-neutral-900/40 text-neutral-400
                   hover:border-neutral-700 hover:text-neutral-300 transition-colors">
        小额阈值
        <span className="text-neutral-100 font-medium tabular-nums">${value}</span>
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
    // 手机上放不下一整行：按钮不许折字（"保存"被挤成两字一行很难看），
    // 说明文字整段掉到下一行
    <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
      <span className="text-[13px] text-neutral-400 whitespace-nowrap">小额阈值 $</span>
      <input
        autoFocus value={draft} inputMode="decimal"
        onChange={(e) => { setDraft(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label="小额阈值（美元）"
        className="w-24 bg-neutral-950 border border-neutral-800 rounded px-2 py-1
                   text-[13px] text-neutral-100 font-medium tabular-nums
                   outline-none focus:border-neutral-600"
      />
      <button type="button" onClick={() => void save()} disabled={saving}
        className="text-xs text-[#3fbf7f] hover:text-[#7ef2b4] disabled:opacity-50 whitespace-nowrap">
        {saving ? '…' : '保存'}
      </button>
      <button type="button" onClick={() => setEditing(false)}
        className="text-xs text-neutral-600 hover:text-neutral-400 whitespace-nowrap">取消</button>
      {/* 低于这个数的币不报警也不显示 —— 必须说清楚，否则用户会以为币丢了 */}
      {err
        ? <span className="text-xs text-[#d03b3b] basis-full sm:basis-auto">{err}</span>
        : <span className="text-xs text-neutral-600 basis-full sm:basis-auto">
            低于此值的不报警，列表里折叠起来
          </span>}
    </div>
  );
}
