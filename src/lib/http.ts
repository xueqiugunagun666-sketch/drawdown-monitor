/**
 * HTTP 客户端：超时、可选代理（§11 的 HTTPS_PROXY）。
 * 失败一律抛出，绝不返回空对象让调用方误以为"没数据"。
 *
 * 注意：这里用 undici 自己的 fetch，而不是 Node 内置的全局 fetch。
 * 全局 fetch 走的是 Node 内部捆绑的另一份 undici，把外部 undici 的
 * ProxyAgent 传给它会报 "invalid onRequestStart method"（两份 undici 版本不一致）。
 */
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { makeLogger } from './log.ts';

const log = makeLogger('http');

let dispatcher: Dispatcher | undefined;
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxyUrl) {
  try {
    dispatcher = new ProxyAgent(proxyUrl);
    log.info(`使用代理: ${new URL(proxyUrl).origin}`);
  } catch (err) {
    // 代理配错要立刻可见，不能悄悄退回直连
    log.exception(`代理配置无效，将直连: ${proxyUrl}`, err);
  }
}

export interface HttpResult {
  status: number;
  body: string;
}

export async function httpGet(url: string, timeoutMs = 15_000): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'drawdown-monitor/0.1' },
      ...(dispatcher ? { dispatcher } : {}),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
