import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  return NextResponse.json({ rules: repo.listRules() });
}

const NUM_FIELDS = [
  'confirmTicks', 'hysteresis', 'rearmMinutes', 'minLiquidityUsd',
  'athSustainCandles', 'cooldownMinutes', 'bouncePct',
] as const;

export async function PUT(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  const id = String(body.id ?? 'default');
  const existing = repo.listRules().find((r) => r.id === id);
  if (!existing) return NextResponse.json({ error: `规则 ${id} 不存在` }, { status: 404 });

  const patch: Record<string, unknown> = { ...existing };

  if (body.levels !== undefined) {
    const raw = Array.isArray(body.levels) ? body.levels : [];
    const levels = raw.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 100);
    if (levels.length === 0) return NextResponse.json({ error: '档位必须是 0-100 之间的数字，至少一个' }, { status: 400 });
    patch.levels = JSON.stringify([...new Set(levels)].sort((a, b) => a - b));
  }
  if (body.athMode !== undefined) {
    const m = String(body.athMode);
    if (!['rolling_90d', 'since_added', 'all_time'].includes(m)) {
      return NextResponse.json({ error: `未知 ATH 模式 ${m}` }, { status: 400 });
    }
    patch.athMode = m;
  }
  if (body.quoteMode !== undefined) {
    const q = String(body.quoteMode);
    if (!['usd', 'native'].includes(q)) return NextResponse.json({ error: `未知计价模式 ${q}` }, { status: 400 });
    patch.quoteMode = q;
  }
  for (const f of NUM_FIELDS) {
    if (body[f] === undefined) continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: `${f} 必须是非负数字` }, { status: 400 });
    patch[f] = n;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;

  repo.upsertRule(patch as Parameters<typeof repo.upsertRule>[0]);
  return NextResponse.json({ rule: repo.listRules().find((r) => r.id === id) });
}
