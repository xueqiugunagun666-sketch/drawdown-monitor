import Link from 'next/link';
import Nav from '../../components/Nav.tsx';
import { fmtUtc, humanAgo, nowSec } from '../../lib/time.ts';
import * as repo from '../../db/repo.ts';
import { severityClass, severityBar } from '../../lib/severity.ts';

export const dynamic = 'force-dynamic';

interface Snapshot {
  liquidityTotal?: number; athLiquidity?: number | null;
  volumeH1?: number; volumeH24?: number;
  txnsH1?: { buys: number; sells: number };
  athMode?: string; quoteMode?: string;
  primaryOverTotal?: number | null;
}

export default function AlertsPage() {
  const alerts = repo.listAlerts(300);
  const now = nowSec();
  const tokens = new Map(repo.listAllTokens().map((t) => [t.id, t]));

  return (
    <main className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <Nav current="/alerts" />
      <h1 className="text-[26px] font-semibold tracking-tight leading-none">报警历史</h1>
      <p className="text-xs text-neutral-600 mt-2 mb-5">
        共 {alerts.length} 条。展开可看触发时的完整快照 —— 这是复盘阈值设得对不对的唯一依据
      </p>

      {alerts.length === 0 ? (
        <p className="text-sm text-neutral-600">还没有报警。</p>
      ) : (
        <div className="space-y-1.5">
          {alerts.map((a) => {
            const t = tokens.get(a.tokenId);
            let snap: Snapshot = {};
            try { snap = a.snapshot ? JSON.parse(a.snapshot) as Snapshot : {}; } catch { /* 快照坏了不影响其余展示 */ }
            let delivered: Array<{ channel: string; ok: boolean; error?: string }> = [];
            try { delivered = a.delivered ? JSON.parse(a.delivered) : []; } catch { /* 同上 */ }
            const failed = delivered.length > 0 && delivered.some((d) => !d.ok);
            const liqRatio = snap.athLiquidity && snap.liquidityTotal
              ? snap.liquidityTotal / snap.athLiquidity : null;
            const dd = a.drawdownUsd !== null ? +a.drawdownUsd : null;

            return (
              <details key={a.id} className="group surface-interactive rounded-lg overflow-hidden relative">
                {/* 左缘严重度色带，与看板同一套语义 */}
                <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${severityBar(dd)}`} />
                <summary className="pl-4 pr-3 py-2.5 cursor-pointer list-none
                                    flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {/* 回撤幅度当锚点：27 行里最该被扫到的就是它，
                      原本它排在时间和币名后面，且不分严重度 */}
                  <span className={`text-lg font-semibold tabular-nums leading-none w-[4.5rem] shrink-0 ${severityClass(dd)}`}>
                    {dd !== null ? `-${dd.toFixed(1)}%` : '—'}
                  </span>
                  <Link href={`/token/${encodeURIComponent(a.tokenId)}`}
                    className="text-[15px] font-medium hover:text-sky-400 shrink-0">
                    {t?.symbol ?? a.tokenId.split(':')[0]}
                  </Link>
                  <span className="meta-label shrink-0">{a.tokenId.split(':')[0]}</span>
                  <span className="badge-quiet shrink-0">{a.level}% 档</span>

                  {/* 投递状态只在异常时显示。原本 27 行每行都挂一个「已送达」，
                      正常状态重复 27 次是噪音，真正要看见的是没送到 */}
                  {delivered.length === 0 && <span className="badge-warn shrink-0">未投递</span>}
                  {failed && <span className="badge-fired shrink-0">投递失败</span>}

                  <span className="ml-auto text-xs text-neutral-600 tabular-nums shrink-0">
                    {humanAgo(a.firedAt, now)}
                  </span>
                  <span className="text-neutral-700 text-xs shrink-0 group-open:rotate-90 transition-transform">›</span>
                </summary>

                <div className="px-3 pb-3 text-xs grid md:grid-cols-2 gap-x-8 gap-y-1 text-neutral-400">
                  <div>触发时刻：{fmtUtc(a.firedAt)}</div>
                  <div>模式：{snap.athMode ?? '—'} / {snap.quoteMode ?? '—'}</div>
                  <div>价格：{a.priceUsd ? (+a.priceUsd).toPrecision(6) : '—'}</div>
                  <div>ATH：{a.athUsd ? (+a.athUsd).toPrecision(6) : '—'}</div>
                  <div>USD 回撤：{a.drawdownUsd ? `-${(+a.drawdownUsd).toFixed(2)}%` : '—'}</div>
                  <div>原生币回撤：{a.drawdownNative ? `${+a.drawdownNative >= 0 ? '-' : '+'}${Math.abs(+a.drawdownNative).toFixed(2)}%` : '—'}</div>
                  <div>流动性（总）：${Math.round(snap.liquidityTotal ?? 0).toLocaleString()}</div>
                  <div>
                    高点时流动性：{snap.athLiquidity ? `$${Math.round(snap.athLiquidity).toLocaleString()}` : '未知（高点来自回填）'}
                    {liqRatio !== null && `（保留 ${(liqRatio * 100).toFixed(0)}%）`}
                  </div>
                  <div>1h 成交：{snap.txnsH1 ? `${snap.txnsH1.buys + snap.txnsH1.sells} 笔（买 ${snap.txnsH1.buys} / 卖 ${snap.txnsH1.sells}）` : '—'}</div>
                  <div>24h 量：${Math.round(snap.volumeH24 ?? 0).toLocaleString()}</div>
                  <div>判断依据：{a.verdictBasis === 'volume_proxy' ? '成交量（高点流动性未知）' : '流动性'}</div>
                  <div>
                    主池占比：{snap.primaryOverTotal != null ? `${(snap.primaryOverTotal * 100).toFixed(0)}%` : '—'}
                  </div>
                  {t?.note && <div className="md:col-span-2 text-neutral-500">备注：{t.note}</div>}
                  {failed && (
                    <div className="md:col-span-2 text-red-400">
                      投递错误：{delivered.filter((d) => !d.ok).map((d) => `${d.channel}: ${d.error}`).join('；')}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </main>
  );
}
