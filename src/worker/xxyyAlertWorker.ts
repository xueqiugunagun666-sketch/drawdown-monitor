/**
 * XXYY 暴涨/ATH 独立进程。
 *
 * 主 worker 同时跑 DexScreener、钱包 RPC、回填和大量同步 SQLite 计算，实测会
 * 把 Node 事件循环堵到 XXYY 请求超时。快报警必须隔离进程，不能只写成同进程
 * 的另一个 async loop 自我安慰“已经并行”。
 */
import { runMigrations } from '../db/migrate.ts';
import { makeLogger } from '../lib/log.ts';
import { nowSec } from '../lib/time.ts';
import { runXxyyAlertTick, XXYY_ALERT_INTERVAL_SECONDS } from './xxyyAlertEngine.ts';

const log = makeLogger('xxyy-alert-worker');
let stopping = false;

async function main(): Promise<void> {
  runMigrations();
  const shutdown = (signal: string) => {
    log.info(`收到 ${signal}，本轮结束后退出`);
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info(`XXYY 暴涨/ATH 独立 worker 已启动，目标间隔 ${XXYY_ALERT_INTERVAL_SECONDS}s`);
  while (!stopping) {
    const started = Date.now();
    try {
      await runXxyyAlertTick(nowSec());
    } catch (error) {
      log.exception('XXYY 暴涨/ATH 快轮次异常', error);
    }
    const wait = XXYY_ALERT_INTERVAL_SECONDS * 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main().catch((error) => {
  log.exception('XXYY 报警 worker 启动失败', error);
  process.exit(1);
});
