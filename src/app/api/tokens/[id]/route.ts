import { NextResponse } from 'next/server';
import { checkAuth } from '../../../../lib/auth.ts';
import * as repo from '../../../../db/repo.ts';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  if (!repo.getToken(tokenId)) return NextResponse.json({ error: '代币不存在' }, { status: 404 });

  let body: { note?: string; enabled?: boolean; frozen?: boolean; tags?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  const patch: Record<string, unknown> = {};
  if (body.note !== undefined) {
    const note = String(body.note).trim();
    // §9.4：备注是强制的，不允许改成空
    if (!note) return NextResponse.json({ error: '备注不能为空 —— 报警时最需要回忆的就是当初为什么关注它' }, { status: 400 });
    patch.note = note;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
  if (body.frozen !== undefined) patch.frozen = body.frozen ? 1 : 0;
  if (body.tags !== undefined) patch.tags = JSON.stringify(body.tags);

  if (Object.keys(patch).length === 0) return NextResponse.json({ error: '没有要修改的字段' }, { status: 400 });
  repo.updateTokenMeta(tokenId, patch);
  return NextResponse.json({ token: repo.getToken(tokenId) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  if (!repo.getToken(tokenId)) return NextResponse.json({ error: '代币不存在' }, { status: 404 });
  repo.deleteToken(tokenId);
  return NextResponse.json({ deleted: tokenId });
}
