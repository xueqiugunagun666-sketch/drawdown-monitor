/**
 * Worker 进程入口 —— 独立于 Next.js 运行。
 *   npm run worker
 */
import { getConfig, getSecrets } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';
import { mask } from '../lib/mask.ts';
import { runMigrations } from '../db/migrate.ts';
import { getDbPath } from '../db/index.ts';
import { pollOnce, refreshNativePrices } from './poller.ts';
import * as repo from '../db/repo.ts';

const log = makeLogger('worker');

function ensureDefaultRule(): void {
  const existing = repo.listRules();
  if (existing.length > 0) return;
  const d = getConfig().defaultRule;
  repo.upsertRule({
    id: 'default', tokenId: null, type: 'drawdown',
    athMode: d.athMode, quoteMode: d.quoteMode,
    levels: JSON.stringify(d.levels),
    confirmTicks: d.confirmTicks, hysteresis: d.hysteresis, rearmMinutes: d.rearmMinutes,
    minLiquidityUsd: d.minLiquidityUsd, athSustainCandles: d.athSustainCandles,
    cooldownMinutes: d.cooldownMinutes, bouncePct: 25,
    channels: JSON.stringify(['telegram']), enabled: 1,
  });
  log.info(`已创建默认规则: ${d.athMode} / ${d.quoteMode} / 档位 ${JSON.stringify(d.levels)}`);
}

function logStartupConfig(): void {
  const cfg = getConfig();
  const s = getSecrets();
  log.info(`DB: ${getDbPath()}`);
  log.info(`轮询间隔 ${cfg.polling.intervalSeconds}s，并发 ${cfg.polling.maxConcurrency}，失联阈值 ${cfg.polling.staleMinutes} 分钟`);
  // 配置一律输出掩码值
  log.info(`TELEGRAM_BOT_TOKEN=${mask(s.telegramBotToken)}  TELEGRAM_CHAT_ID=${mask(s.telegramChatId)}`);
  log.info(`ACCESS_TOKEN=${mask(s.accessToken)}  COINGECKO_API_KEY=${mask(s.coingeckoApiKey)}`);
  if (!s.telegramBotToken || !s.telegramChatId) {
    log.warn('Telegram 未配置，报警将无法投递（会在 alerts.delivered 中记录失败）');
  }
}

let stopping = false;

async function main(): Promise<void> {
  runMigrations();
  ensureDefaultRule();
  logStartupConfig();

  const cfg = getConfig();

  await refreshNativePrices();
  const nativeTimer = setInterval(() => {
    void refreshNativePrices();
  }, cfg.polling.nativePriceIntervalSeconds * 1000);

  const loop = async () => {
    while (!stopping) {
      const started = Date.now();
      try {
        await pollOnce();
      } catch (err) {
        // 轮询本身崩了要显式暴露，然后继续下一轮
        log.exception('轮询异常', err);
      }
      const elapsed = Date.now() - started;
      const wait = Math.max(0, cfg.polling.intervalSeconds * 1000 - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    clearInterval(nativeTimer);
  };

  const shutdown = (sig: string) => {
    log.info(`收到 ${sig}，等待本轮结束后退出`);
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info('worker 已启动');
  await loop();
}

main().catch((err) => {
  log.exception('worker 启动失败', err);
  process.exit(1);
});
