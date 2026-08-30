'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import SoundToggle from '../../components/SoundToggle.tsx';
import WalletList, { type WalletRow } from './WalletList.tsx';
import HoldingsTable, { type HoldingRow } from './HoldingsTable.tsx';
import AlertFeed, { LatestAlertBanner, alertName, type AlertRow } from './AlertFeed.tsx';
import { playPumpSound, notifyPump } from '../../lib/pumpSound.ts';
import { describeBasis } from '../../lib/pumpStyle.ts';

export default function WalletClient() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [chains, setChains] = useState<string[]>([]);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const seen = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [w, h, a] = await Promise.all([
        fetch('/api/wallet/wallets').then((r) => r.json()),
        fetch('/api/wallet/holdings').then((r) => r.json()),
        fetch('/api/wallet/alerts').then((r) => r.json()),
      ]) as [
        { wallets?: WalletRow[]; chains?: string[]; error?: string },
        { holdings?: HoldingRow[] },
        { alerts?: AlertRow[] },
      ];
      if (w.error) { setErr(w.error); return; }
      setWallets(w.wallets ?? []);
      setChains(w.chains ?? []);
      setHoldings(h.holdings ?? []);
      const list = a.alerts ?? [];
      for (const x of list) seen.current.add(x.id);
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
    const es = new EventSource('/api/wallet/stream');
    es.addEventListener('pump', (e) => {
      let fresh: AlertRow[];
      try { fresh = JSON.parse((e as MessageEvent<string>).data) as AlertRow[]; } catch { return; }
      const added = fresh.filter((a) => !seen.current.has(a.id));
      if (added.length === 0) return;
      for (const a of added) seen.current.add(a.id);
      setAlerts((prev) => [...added, ...prev]);

      const top = added.reduce((m, a) => (a.level > m.level ? a : m));
      playPumpSound(top.level);
      // 通知里必须写币名。写地址前缀等于没说 —— 用户看到一串十六进制
      // 仍然不知道是哪个币
      notifyPump(
        `${alertName(top)} 暴涨 ${Number(top.multiple).toFixed(1)}x`,
        `${describeBasis(top.timeframe, top.basis)} · ${top.level}x 档`,
      );
      void load();     // 顺带刷新持仓价值
    });
    return () => es.close();
  }, [load]);

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
      <SoundToggle />
      {/* 横幅放最顶上：用户是听到播报才打开页面的，第一眼必须看到是哪个币 */}
      <LatestAlertBanner alerts={alerts} onFocus={focusToken} />
      <WalletList wallets={wallets} chains={chains} onChange={load} />
      <HoldingsTable holdings={holdings} alertedTokenIds={alertedTokenIds} />
      <AlertFeed alerts={alerts} />
    </div>
  );
}
