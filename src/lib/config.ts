/**
 * 配置加载。密钥只从 env 读，读到即注册到掩码表。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerSecret } from './mask.ts';
import type { ChainId } from '../sources/types.ts';

export interface ChainConfig {
  dexscreenerId: string;
  geckoId: string;
  nativeSymbol: 'ETH' | 'BNB' | 'SOL';
  evmChainId?: number;
  preferredSource?: string;
}

export interface AppConfig {
  chains: Record<ChainId, ChainConfig>;
  defaultRule: {
    athMode: string; quoteMode: string; levels: number[];
    confirmTicks: number; hysteresis: number; rearmMinutes: number;
    minLiquidityUsd: number; athSustainCandles: number; cooldownMinutes: number;
    poolPriceDeviationMax: number;
  };
  polling: {
    intervalSeconds: number; nativePriceIntervalSeconds: number;
    frozenIntervalSeconds: number; staleMinutes: number; maxConcurrency: number;
  };
  retention: { candles5mDays: number; candles1hDays: number | null };
}

let _cfg: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_cfg) return _cfg;
  const path = resolve(process.env.CONFIG_PATH ?? './config.default.json');
  _cfg = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  return _cfg;
}

export interface Secrets {
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  coingeckoApiKey: string | undefined;
  gmgnApiKey: string | undefined;
  evmRpcBase: string | undefined;
  adminAccount: string | undefined;
  /** 群聊淘金：喊单回撤信号接口 */
  trashApiBase: string | undefined;
  trashApiToken: string | undefined;
}

let _secrets: Secrets | null = null;

export function getSecrets(): Secrets {
  if (_secrets) return _secrets;
  const s: Secrets = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    coingeckoApiKey: process.env.COINGECKO_API_KEY || undefined,
    gmgnApiKey: process.env.GMGN_API_KEY || undefined,
    evmRpcBase: process.env.EVM_RPC_BASE || undefined,
    adminAccount: process.env.ADMIN_ACCOUNT || undefined,
    trashApiBase: process.env.TRASH_API_BASE || undefined,
    trashApiToken: process.env.TRASH_API_TOKEN || undefined,
  };
  // 注册后，任何日志/报错里出现这些值都会被自动掩码
  registerSecret(s.telegramBotToken);
  registerSecret(s.coingeckoApiKey);
  registerSecret(s.gmgnApiKey);
  // RPC 端点是用户的私有基础设施，按密钥处理：
  // 不注册的话，eth_getLogs 超时的报错会把完整 URL 打进日志
  registerSecret(s.evmRpcBase);
  registerSecret(s.trashApiToken);
  _secrets = s;
  return s;
}
