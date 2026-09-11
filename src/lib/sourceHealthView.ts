export interface SourceHealthInput {
  sourceId: string;
  consecutiveFailures: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastFailMessage: string | null;
}

export type SourceHealthState = 'healthy' | 'retrying' | 'outage' | 'historical';

export interface SourceHealthView {
  purpose: string;
  critical: boolean;
  state: SourceHealthState;
  text: string;
}

export const HISTORICAL_FAILURE_SECONDS = 3600;

export function sourcePurpose(sourceId: string): { purpose: string; critical: boolean } {
  if (sourceId.startsWith('xxyy-alerts:')) {
    return { purpose: '暴涨 / ATH 当前价', critical: true };
  }
  if (sourceId === 'xxyy-solana-rpc') {
    return { purpose: 'Solana 钱包持仓扫描', critical: false };
  }
  if (sourceId.startsWith('dexscreener:')) {
    return { purpose: '钱包币资格 / 流动性 / 项目链接', critical: false };
  }
  const known: Record<string, string> = {
    coingecko: '原生币美元价',
    dexscreener: '回撤看板报价',
    geckoterminal: '历史 K 线回填兜底',
    gmgn: '历史 K 线回填',
    'gmgn-token-info': '代币符号 / 持有人元数据',
    xxyy: '旧双源一致性记录',
  };
  return { purpose: known[sourceId] ?? '辅助数据源', critical: false };
}

export function sourceHealthView(
  input: SourceHealthInput, now: number,
): SourceHealthView {
  const meta = sourcePurpose(input.sourceId);
  if (input.consecutiveFailures === 0) {
    return { ...meta, state: 'healthy', text: '正常' };
  }

  const age = input.lastFailAt === null ? null : Math.max(0, now - input.lastFailAt);
  const detail = input.lastFailMessage ? ` · ${input.lastFailMessage}` : '';
  if (age !== null && age >= HISTORICAL_FAILURE_SECONDS) {
    return {
      ...meta, state: 'historical',
      text: `历史故障，等待下次复测 · 记录 ${input.consecutiveFailures} 次${detail}`,
    };
  }
  if (meta.critical || input.consecutiveFailures >= 5) {
    return {
      ...meta, state: 'outage',
      text: `服务异常 · 连续失败 ${input.consecutiveFailures} 次${detail}`,
    };
  }
  return {
    ...meta, state: 'retrying',
    text: `短暂失败，正在重试 · ${input.consecutiveFailures} 次${detail}`,
  };
}

export function sourceHealthPriority(sourceId: string): number {
  if (sourceId.startsWith('xxyy-alerts:')) return 0;
  if (sourceId === 'xxyy-solana-rpc') return 1;
  if (sourceId.startsWith('dexscreener:')) return 2;
  return 3;
}
