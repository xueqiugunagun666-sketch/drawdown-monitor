import { NextResponse } from 'next/server';
import { checkAuth } from '../../../../lib/auth.ts';
import { actorFromRequest } from '../../../../lib/accountAuthServer.ts';
import { canDelete, canEditMeta, canToggleGlobal } from '../../../../lib/permissions.ts';
import { notifyPlain } from '../../../../worker/notifier.ts';
import * as repo from '../../../../db/repo.ts';

export const dynamic = 'force-dynamic';

const unauthorized = () => NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
const forbidden = (msg: string) => NextResponse.json({ error: msg }, { status: 403 });

/**
 * 两道闸门都在路由里再查一遍，与本项目其余 10 个路由一致。
 *
 * 中间件已经查过，这里是纵深防御：middleware 的 matcher 排除了静态资源，
 * 将来若有人再加一条排除规则，没有自查的路由会**悄无声息**地失去闸门。
 * 口令那层将来要整体拆掉（改注册邀请码），届时这一行随其余 10 处一起删。
 */
function gate(req: Request): Response | null {
  const auth = checkAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });
  return null;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = gate(req);
  if (denied) return denied;
  const actor = actorFromRequest(req);
  if (!actor) return unauthorized();

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  const token = repo.getToken(tokenId);
  if (!token) return NextResponse.json({ error: '代币不存在' }, { status: 404 });

  let body: { note?: string; enabled?: boolean; frozen?: boolean; tags?: string[]; pinned?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  // 权限先全部判完再动手 —— 部分成功会让人以为整个请求成功了，
  // 回头发现只改了一半
  const touchesGlobal = body.enabled !== undefined || body.frozen !== undefined;
  const touchesMeta = body.note !== undefined || body.tags !== undefined;
  if (touchesGlobal && !canToggleGlobal(actor)) return forbidden('停用与冻结仅管理员可操作');
  if (touchesMeta && !canEditMeta(actor, token.ownerId)) {
    return forbidden('备注只有添加者本人或管理员能改');
  }

  const patch: Record<string, unknown> = {};
  if (body.note !== undefined) {
    const note = String(body.note).trim();
    if (!note) return NextResponse.json({ error: '备注不能为空 —— 报警时最需要回忆的就是当初为什么关注它' }, { status: 400 });
    patch.note = note;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
  if (body.frozen !== undefined) patch.frozen = body.frozen ? 1 : 0;
  if (body.pinned !== undefined) patch.pinned = body.pinned ? 1 : 0;
  if (body.tags !== undefined) patch.tags = JSON.stringify(body.tags);
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: '没有要修改的字段' }, { status: 400 });

  repo.updateTokenMetaAudited(tokenId, patch, {
    actorId: actor.id, actorName: actor.name,
    label: token.symbol ?? null, oldNote: token.note,
  });
  return NextResponse.json({ token: repo.getToken(tokenId) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = gate(req);
  if (denied) return denied;
  const actor = actorFromRequest(req);
  if (!actor) return unauthorized();

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  const token = repo.getToken(tokenId);
  if (!token) return NextResponse.json({ error: '代币不存在' }, { status: 404 });

  if (!canDelete(actor, token.ownerId)) {
    return forbidden('只能删除自己添加的，或者找管理员');
  }

  repo.deleteToken(tokenId, { actorId: actor.id, actorName: actor.name });

  // 推送在事务之外、尽力而为：网络调用绝不能放进数据库事务，
  // 推失败不该让已经完成的删除回滚
  void notifyPlain(`${actor.name} 删除了 ${token.symbol ?? tokenId}（${token.chain}）`);

  return NextResponse.json({ deleted: tokenId });
}
