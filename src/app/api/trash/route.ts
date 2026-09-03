/**
 * 群聊淘金的信号列表。
 *
 * 数据是全站共享的（喊单是公开事实，不属于某个人），所以不按用户过滤 ——
 * 但**仍然必须自查登录**：middleware 跑在 edge runtime 上查不了库，
 * 它只看 cookie 在不在。
 */
import { NextResponse } from 'next/server';
import { currentUser } from '../../../lib/accountAuth.ts';
import { listSignals } from '../../../db/trashRepo.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录' }, { status: 401 });
  return NextResponse.json({ signals: listSignals(2000) });
}
