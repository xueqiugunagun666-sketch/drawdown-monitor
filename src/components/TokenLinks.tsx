'use client';

import { xxyyUrl, dexscreenerUrl } from '../lib/chainLinks.ts';

/**
 * 代币的外链按钮组。
 *
 * 做成图标而不是「Twitter」「Website」这种文字超链接：一行里已经有币名、
 * 地址、倍数、金额在抢注意力，再塞两个英文单词就把行撑散了。图标 14px
 * 见方，四个并排还没有一个词宽。
 *
 * 图标是手写的极简 path，不引图标库 —— 为四个图标拉一个几十 KB 的依赖
 * 不划算，而且这几个形状十年不会变。
 *
 * 安全：全部 target=_blank + rel="noreferrer noopener"。官网与推特地址是
 * **项目方自己在 DexScreener 填的**，等于第三方内容；没有 noopener 的话
 * 打开的页面能通过 window.opener 操纵我们这一页。
 */

export interface TokenLinkProps {
  chain: string;
  address: string;
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  telegramUrl?: string | null;
}

const ICON = 'w-3.5 h-3.5';

function Btn({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={title} aria-label={title}
      // 阻止冒泡：这些按钮常常落在一整行可点的卡片里，
      // 点图标应该只开外链，不该顺带触发那一行自己的跳转
      onClick={(e) => e.stopPropagation()}
      className="text-neutral-600 hover:text-neutral-200 transition-colors shrink-0">
      {children}
    </a>
  );
}

export default function TokenLinks(p: TokenLinkProps) {
  const xxyy = xxyyUrl(p.chain, p.address);
  const ds = dexscreenerUrl(p.chain, p.address);

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      {xxyy && (
        <Btn href={xxyy} title="XXYY 看图">
          {/* K 线：两根柱子，一眼认得出是行情 */}
          <svg viewBox="0 0 16 16" fill="none" className={ICON} aria-hidden="true">
            <path d="M5 2.5v11M11 2.5v11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <rect x="3" y="5" width="4" height="6" rx="1" fill="currentColor" />
            <rect x="9" y="7.5" width="4" height="5" rx="1" fill="currentColor" />
          </svg>
        </Btn>
      )}
      {ds && (
        <Btn href={ds} title="DexScreener">
          {/* 放大镜里一条上行线 */}
          <svg viewBox="0 0 16 16" fill="none" className={ICON} aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M5 8.2l1.6-1.8 1.4 1.2 1.4-2" stroke="currentColor" strokeWidth="1.3"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Btn>
      )}
      {p.twitterUrl && (
        <Btn href={p.twitterUrl} title="推特">
          {/* X 的字标 */}
          <svg viewBox="0 0 16 16" fill="currentColor" className={ICON} aria-hidden="true">
            <path d="M9.34 6.9L14.3 1.2h-1.18L8.82 6.15 5.38 1.2H1.4l5.2 7.47-5.2 6.03h1.18l4.55-5.28 3.63 5.28h3.98L9.34 6.9zm-1.6 1.87l-.53-.75-4.19-5.94h1.8l3.39 4.8.53.75 4.4 6.23h-1.8l-3.6-5.09z" />
          </svg>
        </Btn>
      )}
      {p.telegramUrl && (
        <Btn href={p.telegramUrl} title="电报">
          <svg viewBox="0 0 16 16" fill="currentColor" className={ICON} aria-hidden="true">
            <path d="M14.6 2.3L1.9 7.2c-.7.3-.7.8-.1 1l3.2 1 1.2 3.7c.2.4.3.6.6.6.3 0 .4-.1.6-.3l1.5-1.5 3.2 2.4c.6.3 1 .1 1.2-.5l2.1-9.9c.2-.8-.3-1.1-.8-.9zM6 9.6l7-4.4c.3-.2.6-.1.4.1L7.6 10.7l-.2 2.2L6 9.6z" />
          </svg>
        </Btn>
      )}
      {p.websiteUrl && (
        <Btn href={p.websiteUrl} title="官网">
          {/* 地球：一个圆加经纬 */}
          <svg viewBox="0 0 16 16" fill="none" className={ICON} aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
            <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.5 3.9 2.5 6.2S9.7 12.4 8 14.2C6.3 12.4 5.5 10.3 5.5 8S6.3 3.6 8 1.8z"
              stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </Btn>
      )}
    </span>
  );
}
