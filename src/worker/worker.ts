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
import { runBackfillStep, backfillProgress } from './backfill.ts';
import { backfillNativePrices } from '../sources/nativeHistory.ts';
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

  // 原生币历史：回填出的 USD candle 要靠它推导 native 计价（§2.3）。
  // 每 symbol 一次请求，很便宜，启动时跑一遍即可。
  try {
    await backfillNativePrices();
  } catch (err) {
    log.exception('原生币历史回填失败，native 计价的 ATH 将不完整', err);
  }

  // OHLCV 回填独立于轮询循环推进：GT 限流 5 req/min，
  // 全量回填要数小时，不能阻塞 30 秒的行情轮询。
  const backfillLoop = async () => {
    while (!stopping) {
      let worked = false;
      try {
        worked = await runBackfillStep();
      } catch (err) {
        log.exception('回填步骤异常', err);
      }
      if (!worked) {
        // 队列空，等一会儿再看有没有新加的币
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  };
  void backfillLoop();

  const progressTimer = setInterval(() => {
    const p = backfillProgress();
    if (p.pagesTotal > 0 && p.done < p.jobs) {
      log.info(`回填进度 ${p.pct}% (${p.pagesDone}/${p.pagesTotal} 页, ${p.done}/${p.jobs} 任务完成, 预计还需 ${p.etaMinutes} 分钟)`);
    }
  }, 120_000);

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
    clearInterval(progressTimer);
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
