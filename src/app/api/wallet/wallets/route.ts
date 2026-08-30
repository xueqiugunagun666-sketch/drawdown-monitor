import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { addWallet, listWallets, removeWallet } from '../../../../db/walletRepo.ts';
import { supportedChains } from '../../../../sources/evmRpc.ts';

export const dynamic = 'force-dynamic';

/** EVM 地址格式。本期只做 EVM 链，不接受其它格式 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  return NextResponse.json({ wallets: listWallets(u.id), chains: supportedChains() });
}

export async function POST(req: Request) {
  // userId 只从会话推导，绝不从请求体读 —— 读了隔离就名存实亡
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  let body: { chain?: string; address?: string; label?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求格式错误' }, { status: 400 }); }

  const chain = (body.chain ?? '').trim();
  const address = (body.address ?? '').trim();
  if (!supportedChains().includes(chain)) {
    return NextResponse.json(
      { error: `不支持的链。本期支持：${supportedChains().join(' / ')}` }, { status: 400 });
  }
  if (!EVM_ADDRESS.test(address)) {
    return NextResponse.json({ error: '地址格式不对，应为 0x 开头的 40 位十六进制' }, { status: 400 });
  }

  const label = (body.label ?? '').trim().slice(0, 40) || null;
  const w = addWallet(u.id, chain, address, label);
  if (!w) return NextResponse.json({ error: '这个地址你已经加过了' }, { status: 409 });
  return NextResponse.json({ ok: true, id: w.id });
}

export async function DELETE(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id') ?? '';
  // removeWallet 内部带 user_id 条件，删不掉别人的
  return removeWallet(u.id, id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: '没有这个钱包' }, { status: 404 });
}
