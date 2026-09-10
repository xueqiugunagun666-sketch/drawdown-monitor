import Link from 'next/link';
import Nav from '../../components/Nav.tsx';
import { DEFAULT_THRESHOLDS } from '../../worker/holdingsFilter.ts';
import { LEVELS, REARM_RATIO, DEDUP_WINDOW_SECONDS } from '../../worker/pumpState.ts';
import { TIMEFRAMES, WINDOW_SECONDS } from '../../worker/pumpWindows.ts';
import { SCAN_INTERVAL_SECONDS } from '../../worker/walletScanner.ts';
import { TICK_INTERVAL_SECONDS } from '../../worker/pumpEngine.ts';
import { BACKFILL_SECONDS } from '../../worker/walletBackfill.ts';

export const dynamic = 'force-dynamic';

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
const mins = (s: number) => `${Math.round(s / 60)} 分钟`;
const tfLabel: Record<string, string> = {
  '5m': '5 分钟', '1h': '1 小时', '6h': '6 小时', '24h': '24 小时',
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1.75rem_1fr] gap-4 py-5 border-t border-neutral-900">
      <span className="text-xs text-neutral-600 tabular-nums pt-1">
        {String(n).padStart(2, '0')}
      </span>
      <div>
        <h3 className="text-sm text-neutral-200 mb-2">{title}</h3>
        <div className="text-sm text-neutral-500 leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

/** 补充说明，与正文区分开 —— 这些是"为什么这么设计"，不是操作说明 */
function Why({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-l-2 border-neutral-800 pl-3 text-neutral-600">{children}</p>
  );
}

export default function HowPage() {
  const th = DEFAULT_THRESHOLDS;
  return (
    <main className="mx-auto max-w-3xl p-4">
      <Nav current="/how" />

      <header className="mb-7">
        <h1 className="text-lg text-neutral-200">暴涨报警是怎么判的</h1>
        <p className="text-sm text-neutral-500 mt-1 leading-relaxed">
          它每 {mins(TICK_INTERVAL_SECONDS)}看一次你的每一个币，判断这是不是真的涨起来了。
          一个币要走完下面七步才会让你听到声音。
        </p>
      </header>

      <section>
        <Step n={1} title="找出你有哪些币">
          <p>
            EVM 地址会按链上转账记录找出所有<span className="text-neutral-300">收到过</span>的代币，
            再逐个读当前余额；Solana 地址直接读取经典 SPL Token 与 Token-2022 的完整持仓快照。
            余额为零的都会移除。
          </p>
          <Why>新加的钱包一分钟内开扫，之后每 {mins(SCAN_INTERVAL_SECONDS)}一轮。余额变化远比价格慢。</Why>
        </Step>

        <Step n={2} title="筛掉不值得看的">
          <p>
            这一步是生死线。实测一个活跃地址能扫出<span className="text-neutral-300">七千多个代币</span>，
            其中有价格的不到 5% —— 不筛掉，真正重要的报警会被垃圾淹没。
          </p>
          <ul className="space-y-1.5 !mt-3">
            {[
              ['流动性', `≥ ${usd(th.minLiquidityUsd)}`, '太浅的盘，一笔几百块的买单就能把价格打飞两倍'],
              ['24 小时成交', `≥ ${usd(th.minVolume24hUsd)}`, '假池子撑得起流动性，撑不起真实成交'],
              ['持有人', `≤ ${th.maxHolderCount.toLocaleString('en-US')}`, '几十万人持有的多是空投盘'],
            ].map(([k, v, note]) => (
              <li key={k} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5
                                     rounded bg-[#fab219]/8 border border-[#fab219]/20 px-3 py-2">
                <span className="text-[#fab219] text-sm w-24 shrink-0">{k}</span>
                <span className="text-neutral-300 text-sm tabular-nums">{v}</span>
                <span className="text-neutral-600 text-xs">{note}</span>
              </li>
            ))}
          </ul>
          <Why>
            进出用不同的线：够门槛才进来，要跌破门槛的 {Math.round(th.exitRatio * 100)}%
            并持续 {mins(th.exitSustainSeconds)}才退出。否则卡在边界上的币会反复进出，
            每次重进都把判定状态清零。
          </Why>
        </Step>

        <Step n={3} title="补齐历史">
          <p>
            新进监控的币会自动补最近 {Math.round(BACKFILL_SECONDS / 3600)} 小时的 K 线，通常几十秒补完。
            补不到的窗口显示「数据不足」，不会拿五分钟的数据冒充一天的涨幅。
          </p>
          <Why>
            补来的数据必须和实时价对得上，差 10 倍以上说明两个数据源口径不一致，整批丢弃。
          </Why>
        </Step>

        <Step n={4} title="算涨了几倍">
          <p>四个时间窗口同时算，每个窗口两种口径，一共八个数：</p>
          <div className="flex flex-wrap gap-2 !mt-3">
            {TIMEFRAMES.map((tf) => (
              <span key={tf} className="rounded border border-neutral-800 bg-neutral-950
                                        px-2.5 py-1 text-xs text-neutral-400 tabular-nums">
                {tfLabel[tf] ?? tf}
                <span className="text-neutral-600 ml-1.5">{WINDOW_SECONDS[tf] / 300} 根</span>
              </span>
            ))}
          </div>
          <p>
            <span className="text-neutral-300">从低点算</span>是「从窗口内最低价拉起了几倍」，
            <span className="text-neutral-300">从起点算</span>是「这段时间净涨了几倍」。
            报警里会写明是哪一种。
          </p>
          <Why>
            低点取的是第二或第三低，不是最低。单个异常数据点会让倍数算出天文数字 ——
            真发生过一次。连续多根的低位是真实行情，不会被剔掉。
          </Why>
        </Step>

        <Step n={5} title="跨过档位才触发">
          <div className="flex flex-wrap gap-2 !mt-0 !mb-2">
            {LEVELS.map((l) => (
              <span key={l} className="rounded bg-[#3fbf7f]/10 border border-[#3fbf7f]/25
                                       px-3 py-1.5 text-sm text-[#3fbf7f] tabular-nums">
                {l}×
              </span>
            ))}
          </div>
          <p>
            每档只报一次。报过之后要
            <span className="text-neutral-300">回落到该档位的 {Math.round(REARM_RATIO * 100)}% 以下</span>
            才重新武装 —— 没有这条，一个在两倍上下震荡的币每穿越一次就响一次。
          </p>
          <Why>
            你加钱包之前已经涨过的部分不补报。一个进来时就已经五倍的币，
            只有涨到十倍才会响 —— 那才是新发生的事。
          </Why>
        </Step>

        <Step n={6} title="同一波只报一条">
          <p>
            一波行情会让好几个窗口先后达标。只发倍数最高的那一条；倍数相同时取窗口更短的
            —— 五分钟涨两倍比一天涨两倍值钱。同一个币 {mins(DEDUP_WINDOW_SECONDS)}内不重复报。
          </p>
        </Step>

        <Step n={7} title="叫你">
          <p>
            语音播报「有东西暴涨了」，同时弹系统通知、页面顶部出现横幅、
            对应持仓行标绿并排到最前。
          </p>
          <Why>
            浏览器不允许网页擅自出声，必须先手动点一次「开启声音」。没点的话页面顶部会一直挂着
            黄色横幅 —— 这是最容易出问题的地方，因为它是静悄悄失效的。
          </Why>
        </Step>
      </section>

      <section className="mt-10">
        <h2 className="text-sm text-neutral-400 pb-2 mb-3 border-b border-neutral-900">
          为什么它没报
        </h2>
        <div className="space-y-4 text-sm">
          {[
            ['刚加钱包，一片安静',
             '系统只报「被监控之后新发生的上涨」。想知道现在什么在涨，看持仓列表 —— 它按当前倍数排序，涨两倍以上的数字是绿的。'],
            ['大部分币被过滤掉了',
             '这是对的。点「显示被过滤的」能看到每个币被挡的具体数字。觉得门槛不合适可以调。'],
            ['USDT、WBNB 这些不在监控里',
             `被持有人门槛挡掉了 —— USDT 有五千多万持有人。试过用比例区分空投盘和主流币，但稳定币人人持有、人均交易少，比例反而更难看，没有一条比例能同时分开两类。好在这些币本来也不会涨两倍。`],
            ['24 小时窗口显示「数据不足」',
             '历史还没攒够。宁可说数据不足，也不拿五分钟的数据冒充一天的涨幅。'],
          ].map(([q, a]) => (
            <div key={q}>
              <p className="text-neutral-300">{q}</p>
              <p className="text-neutral-500 mt-1 leading-relaxed">{a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm text-neutral-400 pb-2 mb-3 border-b border-neutral-900">
          数据可信吗
        </h2>
        <p className="text-sm text-neutral-500 leading-relaxed mb-3">
          行情数据经常出错。有一条 <span className="text-neutral-300 tabular-nums">5.96×10²¹ 倍</span> 的
          报警真的发出去过 —— 行情源某一瞬间给一个稳定币返回了 5.56e-24 的价格，那个数成了窗口最低点。
          现在有三道防线：
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[26rem]">
            <thead>
              <tr className="text-xs text-neutral-600 text-left">
                <th className="font-normal py-1.5 pr-4">位置</th>
                <th className="font-normal py-1.5 pr-4">规则</th>
                <th className="font-normal py-1.5">挡住什么</th>
              </tr>
            </thead>
            <tbody className="text-neutral-400">
              {[
                ['入口', '跳变 > 1000×', '单次离谱报价，直接丢弃不入库'],
                ['补历史', '偏离实时价 > 10×', '两个数据源口径不一致，整批丢弃'],
                ['算低点', '取第 2–3 低', '已经混进来的孤立异常值'],
              ].map(([a, b, c]) => (
                <tr key={a} className="border-t border-neutral-900">
                  <td className="py-2 pr-4 text-neutral-300">{a}</td>
                  <td className="py-2 pr-4 tabular-nums">{b}</td>
                  <td className="py-2 text-neutral-500 text-xs">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-neutral-500 leading-relaxed mt-3">
          三道都偏向「宁可漏一根也不放脏数据进来」。漏一根只是少一点历史，
          放进来就是一条假报警 —— 而这种工具喊一次狼来了就会被关掉。
        </p>
      </section>

      <p className="mt-10 pt-4 border-t border-neutral-900 text-xs text-neutral-600">
        每次改动都记在
        <Link href="/changelog" className="text-neutral-500 hover:text-neutral-300 underline underline-offset-2 mx-1">
          更新记录
        </Link>
        里。
      </p>
    </main>
  );
}
