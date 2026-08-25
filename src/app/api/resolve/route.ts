import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import { parseMany } from '../../../lib/parseTokenInput.ts';
import { resolveInput } from '../../../sources/resolve.ts';
import * as repo from '../../../db/repo.ts';

export const dynamic = 'force-dynamic';

/** 加币前的预览：把粘贴的内容解析成确定的代币，前端确认后再提交 */
export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  let body: { text?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  const text = (body.text ?? '').trim();
  if (!text) return NextResponse.json({ error: '请输入地址或链接' }, { status: 400 });

  const parsed = parseMany(text);
  if (parsed.length > 50) return NextResponse.json({ error: '一次最多 50 个' }, { status: 400 });

  const results = await Promise.all(parsed.map(async (p) => {
    const r = await resolveInput(p);
    if (!r.ok) return { raw: p.raw, ok: false as const, error: r.error };
    const id = `${r.value.chain}:${r.value.address}`;
    return {
      raw: p.raw, ok: true as const,
      ...r.value, id,
      alreadyAdded: repo.getToken(id) !== undefined,
    };
  }));

  return NextResponse.json({ results });
}
