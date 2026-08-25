import { NextResponse } from 'next/server';
import { checkAuth } from '../../../lib/auth.ts';
import { readName } from '../../../lib/user.ts';
import * as repo from '../../../db/repo.ts';
import { CHAIN_IDS } from '../../../sources/types.ts';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  return NextResponse.json({ tokens: repo.listAllTokens() });
}

interface AddItem { chain?: string; address?: string; note?: string }

function validate(item: AddItem): string | null {
  if (!item.chain || !(CHAIN_IDS as string[]).includes(item.chain)) {
    return `chain 必须是 ${CHAIN_IDS.join(' | ')}`;
  }
  if (!item.address) return 'address 必填';
  // §9.4：备注必填，强制记录筛选理由
  if (!item.note || !item.note.trim()) return 'note 必填 —— 记录你为什么关注它';
  return null;
}

export async function POST(req: Request) {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  let body: AddItem | { tokens: AddItem[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  const items: AddItem[] = 'tokens' in body && Array.isArray(body.tokens) ? body.tokens : [body as AddItem];
  if (items.length === 0) return NextResponse.json({ error: '没有要添加的代币' }, { status: 400 });
  if (items.length > 50) return NextResponse.json({ error: '一次最多 50 个' }, { status: 400 });

  // 全部校验通过才写入，避免一半成功一半失败
  const errors = items.map(validate).map((e, i) => (e ? `第 ${i + 1} 个: ${e}` : null)).filter(Boolean);
  if (errors.length > 0) return NextResponse.json({ error: errors.join('；') }, { status: 400 });

  const createdBy = readName(req);
  const added = items.map((i) =>
    repo.addToken({ chain: i.chain!, address: i.address!, note: i.note!.trim(), createdBy }),
  );
  // 回填任务由 worker 在首次成功取价、确定主池后自动排队（OHLCV 是按池取的）
  return NextResponse.json({ tokens: added, count: added.length }, { status: 201 });
}
