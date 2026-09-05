'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import SoundToggle from '../../components/SoundToggle.tsx';
import WalletList, { type WalletRow } from './WalletList.tsx';
import HoldingsTable, { type HoldingRow } from './HoldingsTable.tsx';
import AlertFeed, { LatestAlertBanner, alertName, type AlertRow } from './AlertFeed.tsx';
import { baseMarketCap } from '../../lib/alertMarketCap.ts';
import HealthWatch from './HealthWatch.tsx';
import AlarmTest from './AlarmTest.tsx';
import {
  playPumpSound, notifyPump, PUMP_PHRASE, ATH_PHRASE, SYSTEM_PHRASE,
} from '../../lib/pumpSound.ts';
import { humanAgo } from '../../lib/time.ts';
import { money } from '../trash/TrashList.tsx';
import { CURRENT_VERSION } from '../../lib/changelog.ts';
import { shouldPromptReload } from '../../lib/staleClient.ts';
import { usd } from './HoldingsTable.tsx';
import { describeBasis } from '../../lib/pumpStyle.ts';

export default function WalletClient() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [chains, setChains] = useState<string[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  /** 服务端已经是新版本，而这个页面还在跑旧 JS */
  const [staleVersion, setStaleVersion] = useState<string | null>(null);
  /** 小额阈值。null = 还没读到，读到之前不过滤 —— 宁可多显示也不要凭空少几行 */
  const [minValue, setMinValue] = useState<number | null>(null);
  const seen = useRef(new Set<string>());
  /**
   * seen 只在**第一次**加载时灌历史。
   *
   * 之前每次 load() 都灌，于是有个隐蔽的顺序问题：断线期间发的报警，
   * 只要 load() 先跑（比如从睡眠中醒来刷新列表），就会被标成"见过"，
   * 随后 SSE 补播过来时被 added 过滤掉 —— 列表里有，人却没被通知。
   * seen 该表达的是"这条已经通知过用户了"，不是"这条显示过了"。
   */
  const seeded = useRef(false);
  /**
   * 投递游标 —— 是 pump_alerts 的**写入序号**，不是时间戳。
   * 由 ready 事件播种、由每条 pump 事件推进；主动重建连接时带给服务端接着发。
   */
  const cursor = useRef(0);

  const load = useCallback(async () => {
    try {
      const [w, h, a, st] = await Promise.all([
        fetch('/api/wallet/wallets').then((r) => r.json()),
        fetch('/api/wallet/holdings').then((r) => r.json()),
        fetch('/api/wallet/alerts').then((r) => r.json()),
        fetch('/api/wallet/settings').then((r) => r.json()),
      ]) as [
        { wallets?: WalletRow[]; chains?: string[]; error?: string },
        { holdings?: HoldingRow[] },
        { alerts?: AlertRow[] },
        { minAlertValueUsd?: number | null; defaultValue?: number },
      ];
      if (w.error) { setErr(w.error); return; }
      setWallets(w.wallets ?? []);
      setChains(w.chains ?? []);
      setHoldings(h.holdings ?? []);
      setMinValue(st.minAlertValueUsd ?? st.defaultValue ?? 0);
      const list = a.alerts ?? [];
      if (!seeded.current) {
        for (const x of list) seen.current.add(x.id);
        seeded.current = true;
      }
      setAlerts(list);
      setErr(null);
    } catch {
      setErr('加载失败，检查网络');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // SSE：不能用轮询拉报警 —— 后台标签页的定时器会被节流到约一分钟，
  // 而暴涨报警慢一分钟基本就没意义了
  useEffect(() => {
    let es: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      /**
       * 带上游标。EventSource 自动重连用的是建连时那个 URL，改不了，
       * 所以这里的 since 只对**主动重建**有效；自动重连靠服务端读
       * Last-Event-ID。两条路都要留：401（会话过期）会让 EventSource
       * 彻底关闭，不会自动重连，只能靠主动重建。
       */
      const q = cursor.current > 0 ? `?since=${cursor.current}` : '';
      es = new EventSource(`/api/wallet/stream${q}`);

      es.addEventListener('ready', (e) => {
        setOffline(false);
        // 服务端在这里告诉我们它从哪个序号开始盯 —— 主动重建时要从这里接着要
        try {
          const d = JSON.parse((e as MessageEvent<string>).data) as
            { cursor?: number; version?: string };
          if (typeof d.cursor === 'number') cursor.current = d.cursor;
          /**
           * 服务端的版本号是新鲜的，我们手里这个是打包时烙进去的。
           * 不一致就说明这个页面在跑旧代码 —— 一直开着的页面在部署之后
           * 会静默地继续用旧 JS，用户以为在用新版本，其实不是。
           */
          if (shouldPromptReload(d.version, CURRENT_VERSION)) setStaleVersion(d.version!);
        } catch { /* 拿不到就退回不带 since，等于从最新开始，不会重播 */ }
      });

      /**
       * 连接断了必须让用户看见。
       *
       * 这是这个页面最危险的静默失效：SSE 死掉之后页面看起来一切正常，
       * 而"没有报警"和"收不到报警"长得一模一样 —— 用户会以为行情很安静。
       */
      es.onerror = () => {
        if (stopped) return;
        setOffline(true);
        if (es.readyState !== EventSource.CLOSED) return;   // 浏览器会自己重连
        clearTimeout(retry);
        retry = setTimeout(connect, 5000);                  // 彻底关了才自己重建
      };

      es.addEventListener('pump', (e) => {
        setOffline(false);
        let fresh: AlertRow[];
        try { fresh = JSON.parse((e as MessageEvent<string>).data) as AlertRow[]; } catch { return; }
        for (const a of fresh) {
          if (typeof a.seq === 'number') cursor.current = Math.max(cursor.current, a.seq);
        }
        const added = fresh.filter((a) => !seen.current.has(a.id));
        if (added.length === 0) return;
        for (const a of added) seen.current.add(a.id);
        setAlerts((prev) => [...added, ...prev]);

        const top = added.reduce((m, a) => (a.level > m.level ? a : m));
        const isAth = top.kind === 'ath' || top.kind === 'ath-advance';
        const isSystem = top.kind === 'source-down';

        // 两种报警念不同的话 —— 光靠听就能分出是哪一种，
        // 而它们该引起的反应不一样
        // 系统消息不念「暴涨」那句 —— 它不是行情
        playPumpSound({ phrase: isSystem ? SYSTEM_PHRASE : isAth ? ATH_PHRASE : PUMP_PHRASE });

        /**
         * 通知标题必须写币名。系统通知里没法选中复制，弹出一串 0x
         * 等于什么也没告诉用户。
         *
         * 实在没有币名时（新币还没拿到报价），至少把链名带上，
         * 并在正文里给出完整地址 —— 正文虽然也不能复制，
         * 但看得见总比只有截断的地址强。
         */
        const name = alertName(top);
        const nameless = !top.symbol;

        /**
         * 四种报警读起来意思不同，内容**分开写**：
         *
         *   暴涨 3.0x     穿过一个新档位（里程碑）
         *   又涨 4.4x     没升档但同一波还在继续
         *   破历史新高     进入价格发现区，头上没有套牢盘
         *   再创新高       破新高之后又涨了一截
         *
         * ATH 与暴涨要回答的问题根本不同：暴涨答"涨了几倍、从哪个窗口的
         * 什么基准算的"；破新高答"前高是什么时候立的、现在高出多少"。
         * 「前高立于 23 天前」是 ATH 独有且最关键的一句 —— 打破一个立了
         * 三个月的高点，和打破昨天的高点，分量差得远。倍数反而次要：
         * 破新高的意义在"进入价格发现区"，不在涨了几个百分点。
         *
         * ATH 那两条**必须带口径**：我们的历史只从开始监控那天算起，
         * 九成的币覆盖完整可以说「历史新高」，其余只能说「N 天新高」。
         */
        const scope = top.athScope ?? '新高';
        const overPct = ((Number(top.multiple) - 1) * 100).toFixed(0);

        const verb = isAth
          ? (top.kind === 'ath' ? `破${scope}` : `再创${scope}`)
          : (top.kind === 'advance' ? '又涨' : '暴涨');

        /**
         * 市值排在正文最前面 —— 用户是按市值思考的（「从 5 万涨到 10 万」），
         * 而价格是一串 0.00006726，读它要先数零，对"这币现在多大"没帮助。
         */
        const baseMc = baseMarketCap(top.marketCapUsd, top.priceUsd, top.basePriceUsd);
        const mc = top.marketCapUsd != null
          ? `市值 ${baseMc != null ? `${money(baseMc)} → ` : ''}${money(top.marketCapUsd)}`
          : null;
        const detail = [
          mc,
          isAth
            ? [
              top.baseTs ? `前高立于 ${humanAgo(top.baseTs)}` : null,
              `现价高出 ${overPct}%`,
            ].filter(Boolean).join(' · ')
            : top.kind === 'advance'
              ? `${describeBasis(top.timeframe, top.basis)} · 比上次报警又涨了一截`
              : `${describeBasis(top.timeframe, top.basis)} · ${top.level}x 档`,
          top.valueUsd ? `持仓 ${usd(top.valueUsd)}` : null,
        ].filter(Boolean).join(' · ');

        // ATH 标题不带倍数 —— 「破历史新高」本身就是全部信息，
        // 后面缀个 1.1x 反而把重点冲淡；高出多少放正文
        const title = isAth
          ? (nameless ? `${top.chain ?? '未知链'} 上有币${verb}` : `${name} ${verb}`)
          : (nameless
            ? `${top.chain ?? '未知链'} 上有币${verb} ${Number(top.multiple).toFixed(1)}x`
            : `${name} ${verb} ${Number(top.multiple).toFixed(1)}x`);

        notifyPump(
          isSystem ? `报价源 ${top.tokenId.split(':')[1] ?? ''} 可能不可信` : title,
          isSystem
            ? '它与另一个数据源的价格对不上，已连续多轮。详见服务器日志。'
            : [detail, nameless ? top.address ?? top.tokenId : null].filter(Boolean).join('\n'),
        );
        void load();     // 顺带刷新持仓价值
      });
    };

    connect();
    /** 从睡眠/后台回来时补一次：SSE 若已彻底死掉，这是唯一的兜底 */
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      es.close();
    };
  }, [load]);

  /** 返回错误文案；null 表示成功。UI 要能把服务端的拒绝理由原样说出来 */
  const saveMinValue = async (v: number): Promise<string | null> => {
    try {
      const r = await fetch('/api/wallet/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minAlertValueUsd: v }),
      });
      const j = await r.json() as { minAlertValueUsd?: number | null; error?: string };
      if (!r.ok) return j.error ?? '保存失败';
      setMinValue(j.minAlertValueUsd ?? 0);
      return null;
    } catch {
      return '保存失败，检查网络';
    }
  };

  if (loading) return <p className="text-sm text-neutral-600">加载中…</p>;
  if (err) return <p className="text-sm text-[#d03b3b]">{err}</p>;

  /** 最近一小时报过警的币 —— 持仓列表里要把它们标出来并排到最前 */
  const recentCutoff = Math.floor(Date.now() / 1000) - 3600;
  const alertedTokenIds = alerts.filter((a) => a.firedAt >= recentCutoff).map((a) => a.tokenId);

  const focusToken = (tokenId: string) => {
    document.getElementById(`holding-${tokenId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="space-y-6">
      {/* 看门狗：提示音或推送失效时走系统通知 + 标签页告警。
          页面内的横幅在下面，但横幅救不了"人没在看页面"这种情况 */}
      <HealthWatch streamConnected={!offline} />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SoundToggle />
        {/* 告警自己也要能被验证 —— 没验证过的告警不算告警 */}
        <AlarmTest />
      </div>
      {/* 连不上就必须说出来 —— 否则"没有报警"和"收不到报警"长得一模一样 */}
      {offline && (
        <p className="rounded border border-[#fab219] bg-[#fab219]/10 px-3 py-2 text-sm text-[#8a6100]">
          实时推送已断开，正在重连 —— 这段时间的暴涨不会播报。重连后会自动补上。
        </p>
      )}
      {/**
        * 页面在跑旧代码时必须说出来。
        *
        * 这是个静默故障：SSE 连着不断、报警照收，只是渲染用的还是旧 JS ——
        * 部署了新文案，用户看到的仍是老的，而且毫无迹象。2026-09-05 就这么
        * 骗过一次：ATH 报警明明改成了「破历史新高」，用户收到的还是
        * 「暴涨 1.1x · 0x 档」，我差点当成代码 bug 去查。
        *
        * 不自动刷新：用户可能正在输入或看着某个币，替他决定刷新是越权的。
        */}
      {staleVersion && (
        <p className="rounded border border-[#4a8fd6] bg-[#4a8fd6]/10 px-3 py-2 text-sm
                      text-[#2a5f96] flex items-center justify-between gap-3 flex-wrap">
          <span>
            已有新版本 <b>{staleVersion}</b>（这个页面还是 {CURRENT_VERSION}）——
            报警照收，但显示用的是旧代码。
          </span>
          <button type="button" onClick={() => window.location.reload()}
            className="shrink-0 rounded bg-[#4a8fd6] px-3 py-1 text-white hover:bg-[#5fa3e8]">
            刷新
          </button>
        </p>
      )}
      {/* 横幅放最顶上：用户是听到播报才打开页面的，第一眼必须看到是哪个币 */}
      <LatestAlertBanner alerts={alerts} onFocus={focusToken} />
      <WalletList wallets={wallets} chains={chains} onChange={load} />
      {/* 小额阈值放在持仓表头里，不放页面右上角：它影响的就是下面这个列表，
          放在效果发生的地方才看得见 —— 右上角那种位置等于没有 */}
      <HoldingsTable holdings={holdings} alertedTokenIds={alertedTokenIds}
        minValue={minValue ?? 0} onSaveMinValue={saveMinValue} />
      <AlertFeed alerts={alerts} />
    </div>
  );
}
