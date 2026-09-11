import Nav from '../../components/Nav.tsx';
import SettingsForm, { type RuleShape } from './SettingsForm.tsx';
import { getConfig, getSecrets } from '../../lib/config.ts';
import { mask } from '../../lib/mask.ts';
import * as repo from '../../db/repo.ts';
import { currentActor } from '../../lib/accountAuthServer.ts';
import { canToggleGlobal } from '../../lib/permissions.ts';
import { sourceHealthPriority, sourceHealthView } from '../../lib/sourceHealthView.ts';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const rule = repo.listRules().find((r) => r.id === 'default');
  const cfg = getConfig();
  const s = getSecrets();
  const now = Math.floor(Date.now() / 1000);
  const health = repo.listSourceHealth()
    .sort((a, b) => sourceHealthPriority(a.sourceId) - sourceHealthPriority(b.sourceId)
      || a.sourceId.localeCompare(b.sourceId));
  const canEdit = canToggleGlobal(await currentActor());

  return (
    <main className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <Nav current="/settings" />
      <h1 className="text-xl font-semibold mb-1">设置</h1>
      <p className="text-xs text-neutral-500 mb-5">全局默认规则。单代币覆盖规则暂未实现</p>

      {rule ? (
        <SettingsForm rule={rule as unknown as RuleShape} canEdit={canEdit} />
      ) : (
        <p className="text-sm text-amber-400">还没有默认规则 —— 启动一次 worker 会自动创建。</p>
      )}

      <section className="mt-10 max-w-2xl">
        <h2 className="text-sm font-medium mb-3">运行环境（只读）</h2>
        <table className="w-full text-xs">
          <tbody className="text-neutral-400">
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 w-48 text-neutral-500">轮询间隔</td>
              <td>{cfg.polling.intervalSeconds} 秒（并发 {cfg.polling.maxConcurrency}）</td>
            </tr>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 text-neutral-500">钱包暴涨 / ATH</td>
              <td>XXYY 主报价 · 15 秒快轮次；DexScreener 只负责资格与元数据</td>
            </tr>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 text-neutral-500">失联阈值</td>
              <td>{cfg.polling.staleMinutes} 分钟无有效报价即告警</td>
            </tr>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 text-neutral-500">离群池阈值</td>
              <td>价格偏离中位数超过 {cfg.defaultRule.poolPriceDeviationMax}x 即剔除</td>
            </tr>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 text-neutral-500">Telegram</td>
              <td>
                {s.telegramBotToken && s.telegramChatId
                  ? <>已配置 · token {mask(s.telegramBotToken)} · chat {mask(s.telegramChatId)}</>
                  : <span className="text-amber-400">未配置 —— 报警会记为投递失败并在看板顶部提示</span>}
              </td>
            </tr>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 text-neutral-500">注册方式</td>
              <td>邀请码。生成与查看用 <code className="text-neutral-400">npm run invite</code></td>
            </tr>
            {health.map((h) => {
              const view = sourceHealthView(h, now);
              const tone = view.state === 'outage' ? 'text-red-400'
                : view.state === 'retrying' || view.state === 'historical'
                  ? 'text-amber-400' : 'text-neutral-300';
              return (
                <tr key={h.sourceId} className="border-b border-neutral-900 align-top">
                  <td className="py-1.5 pr-3 text-neutral-500">
                    <span className="block">{h.sourceId}</span>
                    <span className="block text-[10px] text-neutral-600">{view.purpose}</span>
                  </td>
                  <td className={`py-1.5 ${tone}`}>
                    {view.critical && (
                      <span className="mr-1.5 rounded border border-red-900/70 px-1 py-0.5 text-[10px] text-red-300">
                        报警关键
                      </span>
                    )}
                    {view.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-xs text-neutral-600 mt-3">
          这些改动需要编辑 <code>config.default.json</code> 或 <code>.env</code> 后重启 worker。
          密钥一律只显示掩码值。
        </p>
      </section>
    </main>
  );
}
