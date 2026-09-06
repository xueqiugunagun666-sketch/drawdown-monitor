'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import SoundToggle from '../../components/SoundToggle.tsx';
import WalletList, { type WalletRow } from './WalletList.tsx';
import HoldingsTable, { type HoldingRow } from './HoldingsTable.tsx';
import AlertFeed, {
  LatestAlertBanner, alertName, type AlertRow,
} from './AlertFeed.tsx';
import HealthWatch from './HealthWatch.tsx';
import AlarmTest from './AlarmTest.tsx';
import {
  playPumpSound, notifyPump, PUMP_PHRASE, ATH_PHRASE, SYSTEM_PHRASE,
  MIXED_ALERT_PHRASE, SYSTEM_AND_MARKET_PHRASE,
  type NotificationAttempt,
} from '../../lib/pumpSound.ts';
import { CURRENT_VERSION } from '../../lib/changelog.ts';
import { shouldPromptReload } from '../../lib/staleClient.ts';
import { alertStreamUrl, mergeAlertRows } from './alertStreamState.ts';
import {
  buildAlertBatch, buildNotificationSpecs,
  type AlertSoundKind, type NotificationSpec,
} from './notificationBatch.ts';

interface DeliveryFailure {
  spec: NotificationSpec;
  reason: string;
}

type RuntimeStatus = 'unknown' | 'healthy' | 'degraded' | 'down';

interface BusinessHealth {
  /** 用浏览器收包时间，不拿服务端时钟与本机时钟硬减。 */
  receivedAt: number;
  pumpStatus: RuntimeStatus;
  alertsRead: 'ok' | 'error';
  problemScopes: string[];
}

function soundPhrase(kind: AlertSoundKind | null): string | null {
  switch (kind) {
    case 'system': return SYSTEM_PHRASE;
    case 'ath': return ATH_PHRASE;
    case 'pump-and-ath': return MIXED_ALERT_PHRASE;
    case 'system-and-market': return SYSTEM_AND_MARKET_PHRASE;
    case 'pump': return PUMP_PHRASE;
    default: return null;
  }
}

function notificationFailureReason(result: NotificationAttempt): string | null {
  if (result.accepted) return null;
  switch (result.reason) {
    case 'unsupported': return '当前浏览器不支持系统通知';
    case 'permission-default': return '系统通知尚未授权，请在页面顶部允许通知';
    case 'permission-denied': return '系统通知已被拒绝，请在浏览器设置中重新允许';
    case 'constructor-failed': return '浏览器拒绝了本次系统通知调用';
  }
}

export default function WalletClient() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [chains, setChains] = useState<string[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [streamEstablished, setStreamEstablished] = useState(false);
  const [businessHealth, setBusinessHealth] = useState<BusinessHealth | null>(null);
  /** 历史快照边界确定之后才允许建立 SSE，堵住两者之间的首条报警空隙。 */
  const [snapshotReady, setSnapshotReady] = useState(false);
  /** 服务端已经是新版本，而这个页面还在跑旧 JS */
  const [staleVersion, setStaleVersion] = useState<string | null>(null);
  /** 小额阈值。null = 还没读到，读到之前不过滤 —— 宁可多显示也不要凭空少几行 */
  const [minValue, setMinValue] = useState<number | null>(null);
  /**
   * 这是浏览器侧的处理去重，不是 SSE transport cursor，也不代表系统通知一定
   * 成功。历史快照会播种它以避免刷新时重播；实时行先合并进页面，再记录为已处理。
   */
  const handled = useRef(new Set<string>());
  const [deliveryFailures, setDeliveryFailures] = useState<DeliveryFailure[]>([]);
  /**
   * handled 只在**第一次**加载时灌历史。
   *
   * 之前每次 load() 都灌，于是有个隐蔽的顺序问题：断线期间发的报警，
   * 只要 load() 先跑（比如从睡眠中醒来刷新列表），就会被标成"见过"，
   * 随后 SSE 补播过来时被 added 过滤掉 —— 列表里有，人却没被通知。
   * handled 只表达"这条已经进入当前页的处理队列"；系统通知成功与否另记在
   * deliveryFailures，不能再用一个 Set 假装两件事相同。
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
        { alerts?: AlertRow[]; snapshotSeq?: number },
        { minAlertValueUsd?: number | null; defaultValue?: number },
      ];
      if (w.error) { setErr(w.error); return; }
      setWallets(w.wallets ?? []);
      setChains(w.chains ?? []);
      setHoldings(h.holdings ?? []);
      setMinValue(st.minAlertValueUsd ?? st.defaultValue ?? 0);
      const list = a.alerts ?? [];
      if (!seeded.current) {
        if (!Number.isInteger(a.snapshotSeq) || (a.snapshotSeq ?? -1) < 0) {
          throw new Error('报警历史缺少快照游标');
        }
        for (const x of list) handled.current.add(x.id);
        cursor.current = a.snapshotSeq!;
        seeded.current = true;
        setSnapshotReady(true);
      }
      setAlerts((prev) => mergeAlertRows(prev, list));
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
    if (!snapshotReady) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      setStreamEstablished(false);
      /**
       * 带上游标。EventSource 自动重连用的是建连时那个 URL，改不了，
       * 所以这里的 since 只对**主动重建**有效；自动重连靠服务端读
       * Last-Event-ID。两条路都要留：401（会话过期）会让 EventSource
       * 彻底关闭，不会自动重连，只能靠主动重建。
       */
      const connection = new EventSource(alertStreamUrl(cursor.current));
      es = connection;

      connection.addEventListener('ready', (e) => {
        setOffline(false);
        setStreamEstablished(true);
        // 服务端在这里告诉我们它从哪个序号开始盯 —— 主动重建时要从这里接着要
        try {
          const d = JSON.parse((e as MessageEvent<string>).data) as
            { cursor?: number; version?: string };
          if (typeof d.cursor === 'number') cursor.current = Math.max(cursor.current, d.cursor);
          /**
           * 服务端的版本号是新鲜的，我们手里这个是打包时烙进去的。
           * 不一致就说明这个页面在跑旧代码 —— 一直开着的页面在部署之后
           * 会静默地继续用旧 JS，用户以为在用新版本，其实不是。
           */
          if (shouldPromptReload(d.version, CURRENT_VERSION)) setStaleVersion(d.version!);
        } catch { /* 保留建连时的快照游标，不允许静默跳到最新 */ }
      });

      /**
       * 连接断了必须让用户看见。
       *
       * 这是这个页面最危险的静默失效：SSE 死掉之后页面看起来一切正常，
       * 而"没有报警"和"收不到报警"长得一模一样 —— 用户会以为行情很安静。
       */
      connection.onerror = () => {
        if (stopped) return;
        setOffline(true);
        setStreamEstablished(false);
        if (connection.readyState !== EventSource.CLOSED) return; // 浏览器会自己重连
        clearTimeout(retry);
        retry = setTimeout(connect, 5000);                  // 彻底关了才自己重建
      };

      connection.addEventListener('pump', (e) => {
        setOffline(false);
        setStreamEstablished(true);
        let fresh: AlertRow[];
        try { fresh = JSON.parse((e as MessageEvent<string>).data) as AlertRow[]; } catch { return; }
        for (const a of fresh) {
          if (typeof a.seq === 'number') cursor.current = Math.max(cursor.current, a.seq);
        }
        const added = fresh.filter((a) => !handled.current.has(a.id));
        if (added.length === 0) return;
        // 先把同批全部交给页面列表，再做声音/系统通知。通知失败不能让行情
        // 从页面消失，也不能让下一次 SSE 重放把同一批重复入队。
        for (const a of added) handled.current.add(a.id);
        setAlerts((prev) => mergeAlertRows(prev, added));

        const batch = buildAlertBatch(added);
        const phrase = soundPhrase(batch.sound);
        if (phrase) playPumpSound({ phrase });

        // 声音只响一次；系统与行情各有一条独立摘要，系统故障不能把行情盖掉。
        for (const spec of buildNotificationSpecs(
          batch, (a) => a.symbol ?? a.address ?? alertName(a),
        )) {
          const result = notifyPump(spec.title, spec.body, { tag: spec.tag });
          const reason = notificationFailureReason(result);
          if (!reason) continue;
          setDeliveryFailures((prev) => prev.some((x) => x.spec.tag === spec.tag)
            ? prev
            : [...prev, { spec, reason }]);
        }
        void load();     // 顺带刷新持仓价值
      });

      connection.addEventListener('health', (e) => {
        setOffline(false);
        setStreamEstablished(true);
        const receivedAt = Math.floor(Date.now() / 1000);
        try {
          const d = JSON.parse((e as MessageEvent<string>).data) as {
            alertsRead?: 'ok' | 'error';
            rows?: Array<{ component?: string; scope?: string; status?: RuntimeStatus }>;
          };
          if (!Array.isArray(d.rows) || (d.alertsRead !== 'ok' && d.alertsRead !== 'error')) {
            throw new Error('health payload malformed');
          }
          const pump = d.rows.find((row) => row.component === 'pump' && row.scope === 'all');
          const problemScopes = d.rows
            .filter((row) => row.status === 'down' || row.status === 'degraded')
            .map((row) => row.scope ?? 'unknown');
          setBusinessHealth({
            receivedAt,
            pumpStatus: pump?.status ?? 'unknown',
            alertsRead: d.alertsRead,
            problemScopes,
          });
        } catch {
          // 心跳格式坏了也不能当作收到了一份健康证明。
          setBusinessHealth({
            receivedAt, pumpStatus: 'unknown', alertsRead: 'error',
            problemScopes: ['health-payload'],
          });
        }
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
      es?.close();
    };
  }, [load, snapshotReady]);

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
      <HealthWatch
        streamConnected={streamEstablished && !offline}
        businessHeartbeatAt={businessHealth?.receivedAt ?? null}
        backendDown={businessHealth !== null && (
          businessHealth.pumpStatus === 'down'
          || businessHealth.pumpStatus === 'unknown'
          || businessHealth.problemScopes.length > 0
            && businessHealth.problemScopes.some((scope) => scope !== 'all')
        )}
        alertReadDown={businessHealth?.alertsRead === 'error'}
      />
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
      {businessHealth?.pumpStatus === 'degraded' && (
        <p className="rounded border border-[#fab219] bg-[#fab219]/10 px-3 py-2 text-sm text-[#d69a1b]">
          暴涨监测正在降级运行：{businessHealth.problemScopes.join('、') || '部分行情或判定失败'}。
          页面仍会接收已成功生成的报警，系统正在继续重试。
        </p>
      )}
      {deliveryFailures.length > 0 && (
        <div role="alert" className="rounded-lg border-2 border-[#d03b3b]/70 bg-[#d03b3b]/10
                                     px-3 py-2.5 text-sm text-[#f5a4a4]">
          <p className="font-semibold text-[#ffb1b1]">系统通知没有送达，但报警没有丢失</p>
          <p className="mt-1 text-neutral-300">
            下面这些事件已经保留在「异动记录」里；失败原因不会自动消失，避免把“没有弹窗”误当成“没有行情”。
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-[#f5c0c0]">
            {deliveryFailures.map((failure) => (
              <li key={failure.spec.tag}>
                {failure.spec.channel === 'system' ? '系统' : '行情'}通知（{failure.spec.alertIds.length} 条）：{failure.reason}
              </li>
            ))}
          </ul>
        </div>
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
