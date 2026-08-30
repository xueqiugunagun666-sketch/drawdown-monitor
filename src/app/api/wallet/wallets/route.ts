import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { addWallet, listWallets, removeWalletByAddress } from '../../../../db/walletRepo.ts';
import { supportedChains } from '../../../../sources/evmRpc.ts';

export const dynamic = 'force-dynamic';

/** EVM 地址格式。本期四条链都是 EVM，格式统一 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  return NextResponse.json({ wallets: listWallets(u.id), chains: supportedChains() });
}

/**
 * 添加一个地址 —— **默认在全部支持的链上都监控**。
 *
 * 四条链都是 EVM，同一个私钥在每条链上都是同一个地址，绝大多数人
 * 就是同一个钱包多链在用。让人一条链填一次纯属折磨。
 *
 * 底层仍然是每链一行：各链的扫描水位（last_scanned_block）必须分开存，
 * 块高完全不同。这里只是把"建四行"这件事收进一次操作。
 */
export async function POST(req: Request) {
  // userId 只从会话推导，绝不从请求体读
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  let body: { address?: string; label?: string; chains?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求格式错误' }, { status: 400 }); }

  const address = (body.address ?? '').trim();
  if (!EVM_ADDRESS.test(address)) {
    return NextResponse.json({ error: '地址格式不对，应为 0x 开头的 40 位十六进制' }, { status: 400 });
  }

  const all = supportedChains();
  const chains = Array.isArray(body.chains) && body.chains.length > 0
    ? body.chains.filter((c) => all.includes(c))
    : all;
  if (chains.length === 0) {
    return NextResponse.json({ error: `没有可用的链。支持：${all.join(' / ')}` }, { status: 400 });
  }

  const label = (body.label ?? '').trim().slice(0, 40) || null;
  const added: string[] = [];
  const already: string[] = [];
  for (const chain of chains) {
    if (addWallet(u.id, chain, address, label)) added.push(chain);
    else already.push(chain);
  }

  // 全部都已存在才算重复；部分成功要如实说明，不能假装全成功
  if (added.length === 0) {
    return NextResponse.json({ error: '这个地址你已经加过了' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, added, already });
}

/** 按地址删除该地址在所有链上的监控 */
export async function DELETE(req: Request) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  const address = new URL(req.url).searchParams.get('address') ?? '';
  const n = removeWalletByAddress(u.id, address);
  return n > 0
    ? NextResponse.json({ ok: true, removed: n })
    : NextResponse.json({ error: '没有这个钱包' }, { status: 404 });
}
