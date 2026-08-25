'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface RuleShape {
  id: string; athMode: string; quoteMode: string; levels: string;
  confirmTicks: number; hysteresis: number; rearmMinutes: number;
  minLiquidityUsd: number; athSustainCandles: number; cooldownMinutes: number;
}

const NUM: Array<[key: keyof RuleShape, label: string, hint: string]> = [
  ['confirmTicks', '确认次数', '连续几轮达到阈值才触发，防抖'],
  ['hysteresis', '迟滞（百分点）', '回撤需回落这么多才重新武装'],
  ['rearmMinutes', '重新武装（分钟）', '回落后要持续这么久才重新武装'],
  ['cooldownMinutes', '冷却（分钟）', '同一代币任意档位之间的最小间隔'],
  ['minLiquidityUsd', '最低流动性（USD）', '低于此值不触发，用的是全池合计'],
  ['athSustainCandles', 'k（第 k 高收盘价）', 'ATH 取合格 candle 中第 k 高的 close，越大越保守'],
];

export default function SettingsForm({ rule }: { rule: RuleShape }) {
  const router = useRouter();
  const [form, setForm] = useState(() => ({
    ...rule,
    levelsText: (JSON.parse(rule.levels) as number[]).join(', '),
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    const levels = form.levelsText.split(/[,，\s]+/).filter(Boolean).map(Number);
    try {
      const res = await fetch('/api/rules', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: form.id, athMode: form.athMode, quoteMode: form.quoteMode, levels,
          confirmTicks: form.confirmTicks, hysteresis: form.hysteresis,
          rearmMinutes: form.rearmMinutes, minLiquidityUsd: form.minLiquidityUsd,
          athSustainCandles: form.athSustainCandles, cooldownMinutes: form.cooldownMinutes,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? `HTTP ${res.status}`); return; }
      setMsg('已保存。worker 下一轮生效。');
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded bg-neutral-900 border border-neutral-800 px-2 py-1.5 text-sm focus:outline-none focus:border-neutral-600';

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <label className="block text-sm mb-1">报警档位</label>
        <input value={form.levelsText} onChange={(e) => setForm({ ...form, levelsText: e.target.value })}
          className={field} placeholder="80, 85, 90, 95" />
        <p className="text-xs text-neutral-600 mt-1">逗号分隔。每档独立触发一次，但受下面的冷却间隔约束</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm mb-1">ATH 模式</label>
          <select value={form.athMode} onChange={(e) => setForm({ ...form, athMode: e.target.value })} className={field}>
            <option value="rolling_90d">90 天滚动</option>
            <option value="since_added">加入以来</option>
            <option value="all_time">全历史</option>
          </select>
        </div>
        <div>
          <label className="block text-sm mb-1">计价</label>
          <select value={form.quoteMode} onChange={(e) => setForm({ ...form, quoteMode: e.target.value })} className={field}>
            <option value="usd">USD</option>
            <option value="native">原生币</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {NUM.map(([key, label, hint]) => (
          <div key={key}>
            <label className="block text-sm mb-1">{label}</label>
            <input type="number" value={String(form[key])}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
              className={field} />
            <p className="text-xs text-neutral-600 mt-1">{hint}</p>
          </div>
        ))}
      </div>

      {err && <div className="p-3 rounded border border-red-900 bg-red-950/40 text-sm text-red-300">{err}</div>}
      {msg && <div className="p-3 rounded border border-green-900 bg-green-950/30 text-sm text-green-300">{msg}</div>}

      <button onClick={save} disabled={busy}
        className="px-4 py-2 rounded bg-sky-800 text-sm hover:bg-sky-700 disabled:opacity-40">
        {busy ? '保存中…' : '保存'}
      </button>
    </div>
  );
}
