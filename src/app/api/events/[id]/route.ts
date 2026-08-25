import { NextResponse } from 'next/server';
import { checkAuth } from '../../../../lib/auth.ts';
import { parseEventInput } from '../../../../lib/eventInput.ts';
import * as repo from '../../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id } = await ctx.params;
  const existing = repo.getEvent(id);
  if (!existing) return NextResponse.json({ error: '日程不存在' }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  // 只改启用状态时不必走全量校验
  if (Object.keys(body).length === 1 && 'enabled' in body) {
    repo.upsertEvent({ ...existing, enabled: body.enabled ? 1 : 0 });
    return NextResponse.json({ event: repo.getEvent(id) });
  }

  const parsed = parseEventInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const v = parsed.value;

  // 时间或提醒点变了就清空已发记录，否则改期后新的提醒点不会触发
  const timeChanged = v.atTs !== existing.atTs;
  const offsetsChanged = JSON.stringify(v.remindOffsets) !== existing.remindOffsets;

  repo.upsertEvent({
    ...existing,
    title: v.title, atTs: v.atTs, inputTz: v.inputTz,
    category: v.category, priority: v.priority, note: v.note,
    links: JSON.stringify(v.links),
    remindOffsets: JSON.stringify(v.remindOffsets),
    remindedOffsets: timeChanged || offsetsChanged ? null : existing.remindedOffsets,
  });
  return NextResponse.json({ event: repo.getEvent(id) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  const { id } = await ctx.params;
  if (!repo.getEvent(id)) return NextResponse.json({ error: '日程不存在' }, { status: 404 });
  repo.deleteEvent(id);
  return NextResponse.json({ deleted: id });
}
