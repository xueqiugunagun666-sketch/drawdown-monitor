/**
 * 外部站点的链接拼装。
 *
 * 链名映射是**逐条在浏览器里验过的**，不是照着猜的：这些站都是单页应用，
 * 所有路径都回 200，光看状态码分不出对错，只能看真的渲染出没渲染出那个币。
 *   robinhood -> robin   （FLETCH 验过；www.xxyy.io 上进不去，必须是 pro 子域）
 *   ethereum  -> eth     （写 ethereum 会被踢回 /discover）
 *   bsc / base / sol     （USDT / USDC / USDC 各验过一个）
 */
export const XXYY_CHAIN: Record<string, string> = {
  robinhood: 'robin',
  ethereum: 'eth',
  bsc: 'bsc',
  base: 'base',
  solana: 'sol',
};

/** DexScreener 用的是全名，与我们内部一致，只有 solana 例外要留意 */
export const DEXSCREENER_CHAIN: Record<string, string> = {
  robinhood: 'robinhood',
  ethereum: 'ethereum',
  bsc: 'bsc',
  base: 'base',
  solana: 'solana',
};

/**
 * 链名归一。
 *
 * 上游数据源用的名字跟我们内部的不一样：群聊淘金那个接口回的是 `sol`，
 * 我们内部叫 `solana`。不归一的结果是那些行的按钮**静默消失** ——
 * 而"没有按钮"和"这个币没绑社交"长得一模一样，不会有人发现。
 * （线上真实数据里已经出现了 sol，是跑种子脚本时撞出来的。）
 */
const ALIAS: Record<string, string> = {
  sol: 'solana',
  eth: 'ethereum',
  binance: 'bsc',
  'binance-smart-chain': 'bsc',
  robin: 'robinhood',
};

export function normalizeChain(chain: string): string {
  const c = (chain ?? '').trim().toLowerCase();
  return ALIAS[c] ?? c;
}

/** 不认识的链返回 null —— 拼一个进不去的地址还不如不给按钮 */
export function xxyyUrl(chain: string, address: string): string | null {
  const slug = XXYY_CHAIN[normalizeChain(chain)];
  return slug && address ? `https://pro.xxyy.io/${slug}/${address}` : null;
}

export function dexscreenerUrl(chain: string, address: string): string | null {
  const slug = DEXSCREENER_CHAIN[normalizeChain(chain)];
  return slug && address ? `https://dexscreener.com/${slug}/${address}` : null;
}
