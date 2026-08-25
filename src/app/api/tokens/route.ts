import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import * as repo from '../../../db/repo.ts';
import { CHAIN_IDS } from '../../../sources/types.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  return NextResponse.json({ tokens: repo.listAllTokens() });
}

export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  let body: { chain?: string; address?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const { chain, address, note } = body;
  if (!chain || !(CHAIN_IDS as string[]).includes(chain)) {
    return NextResponse.json({ error: `chain 必须是 ${CHAIN_IDS.join(' | ')}` }, { status: 400 });
  }
  if (!address) return NextResponse.json({ error: 'address 必填' }, { status: 400 });
  // §9.4：note 必填，强制记录筛选理由
  if (!note || !note.trim()) return NextResponse.json({ error: 'note 必填 —— 记录你为什么关注它' }, { status: 400 });

  return NextResponse.json({ token: repo.addToken({ chain, address, note: note.trim() }) }, { status: 201 });
}
