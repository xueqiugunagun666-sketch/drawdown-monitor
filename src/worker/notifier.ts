/**
 * 通知层 —— 规格 §8。Phase 1：Telegram 单频道。
 *
 * 投递结果必须写回 alerts.delivered（§8.3）。
 * 失败重试 3 次指数退避，仍失败则记录失败原因供 UI 顶部横幅展示 ——
 * 投递失败静默丢弃是最危险的失效模式。
 */
import { httpGet, sleep } from '../lib/http.ts';
import { getSecrets } from '../lib/config.ts';
import { makeLogger } from '../lib/log.ts';
import { safeErrorMessage } from '../lib/mask.ts';
import { formatPrice } from '../lib/decimal.ts';
import { humanAgo, fmtUtc } from '../lib/time.ts';
import * as repo from '../db/repo.ts';
import type { FiredAlert } from './engine.ts';

const log = makeLogger('notifier');

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  at: number;
  error?: string;
}

function buildMessage(a: FiredAlert): string {
  const q = a.quote;
  const sym = a.token.symbol ?? q.symbol ?? a.token.address.slice(0, 8);
  const lines: string[] = [];

  lines.push(`${sym} 回撤 -${a.drawdownUsd.toFixed(1)}%  (${a.token.chain})`);
  lines.push('');
  lines.push(`价格   $${formatPrice(a.priceUsd, 6)}  ←  ATH $${formatPrice(a.athUsd, 6)}`);
  lines.push(`USD 回撤      -${a.drawdownUsd.toFixed(1)}%`);
  if (a.athTs) lines.push(`高点时间   ${humanAgo(a.athTs)} (${fmtUtc(a.athTs)})  [since_added]`);
  lines.push('');

  const liqNow = Math.round(q.liquidityTotal).toLocaleString();
  if (a.athLiquidity && a.athLiquidity > 0) {
    const pct = ((q.liquidityTotal / a.athLiquidity) * 100).toFixed(0);
    lines.push(`流动性   $${liqNow}  (高点时 $${Math.round(a.athLiquidity).toLocaleString()}, 保留 ${pct}%)`);
  } else {
    lines.push(`流动性   $${liqNow}`);
  }
  lines.push(`1h 成交   ${q.txns.h1.buys + q.txns.h1.sells} 笔 (买 ${q.txns.h1.buys} / 卖 ${q.txns.h1.sells})`);
  lines.push(`24h 量   $${Math.round(q.volume.h24).toLocaleString()}`);

  const ratio = q.liquidityTotal > 0 ? q.liquidityPrimary / q.liquidityTotal : 1;
  if (ratio < 0.5) {
    lines.push(`主池仅占总流动性 ${(ratio * 100).toFixed(0)}%，价格代表性下降`);
  }
  if (!q.crossValidated) {
    lines.push(`该代币池数 < 3，价格无交叉验证`);
  }
  const outliers = q.allPools.filter((p) => p.isOutlier).length;
  if (outliers > 0) {
    lines.push(`已剔除 ${outliers} 个价格离群池`);
  }

  if (a.token.note) {
    lines.push('');
    lines.push(`备注: ${a.token.note}`);
  }
  lines.push('');
  lines.push(`https://dexscreener.com/${a.token.chain}/${q.primaryPool.address}`);
  return lines.join('\n');
}

async function sendTelegram(text: string): Promise<void> {
  const { telegramBotToken, telegramChatId } = getSecrets();
  if (!telegramBotToken || !telegramChatId) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 未配置');
  }
  const url =
    `https://api.telegram.org/bot${telegramBotToken}/sendMessage` +
    `?chat_id=${encodeURIComponent(telegramChatId)}` +
    `&disable_web_page_preview=true` +
    `&text=${encodeURIComponent(text)}`;

  const res = await httpGet(url, 20_000);
  if (res.status !== 200) {
    // res.body 可能含 token，scrubSecrets 在 log/safeErrorMessage 里兜底
    throw new Error(`Telegram HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as { ok?: boolean; description?: string };
  if (!parsed.ok) throw new Error(`Telegram 拒绝: ${parsed.description ?? '未知原因'}`);
}

/** 投递一条报警，结果写回 alerts.delivered */
export async function deliver(a: FiredAlert): Promise<DeliveryResult[]> {
  const text = buildMessage(a);
  const results: DeliveryResult[] = [];

  let lastErr = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendTelegram(text);
      ok = true;
      break;
    } catch (err) {
      lastErr = safeErrorMessage(err);
      log.warn(`Telegram 投递失败 (第 ${attempt}/3 次): ${lastErr}`);
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }

  results.push({
    channel: 'telegram',
    ok,
    at: Math.floor(Date.now() / 1000),
    ...(ok ? {} : { error: lastErr }),
  });

  repo.updateAlertDelivery(a.id, JSON.stringify(results));
  if (!ok) {
    log.error(`报警 ${a.id} 全部投递失败，UI 需显示横幅告警`, { error: lastErr });
  } else {
    log.info(`报警 ${a.id} 已投递 Telegram`);
  }
  return results;
}

export { buildMessage };
