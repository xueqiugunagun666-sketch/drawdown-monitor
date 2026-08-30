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

/**
 * NO_PROXY 白名单。undici 的 ProxyAgent 不认这个变量，得自己判。
 *
 * 不判的后果不只是测试跑不起来：本机调试时对 127.0.0.1 的请求会被
 * 塞进代理然后失败，而失败信息看起来像是目标服务挂了。
 */
const noProxyList = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export function shouldBypassProxy(url: string, list: string[] = noProxyList): boolean {
  if (list.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return list.some((entry) => {
    if (entry === '*') return true;
    const e = entry.startsWith('.') ? entry.slice(1) : entry;
    return host === e || host.endsWith('.' + e);
  });
}

function dispatcherFor(url: string): Dispatcher | undefined {
  return shouldBypassProxy(url) ? undefined : dispatcher;
}

export interface HttpResult {
  status: number;
  body: string;
}

export async function httpGet(
  url: string,
  timeoutMs = 15_000,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const proxy = dispatcherFor(url);
  try {
    const res = await undiciFetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'drawdown-monitor/0.1', ...extraHeaders },
      ...(proxy ? { dispatcher: proxy } : {}),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * JSON POST —— JSON-RPC 用。
 *
 * 超时默认 30 秒而非 httpGet 的 15 秒：全链范围的 eth_getLogs 实测要 4.5 秒，
 * 自适应二分递归时更慢，15 秒会误杀成"节点故障"。
 */
export async function httpPostJson(
  url: string,
  body: unknown,
  timeoutMs = 30_000,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const proxy = dispatcherFor(url);
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'drawdown-monitor/0.1',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      ...(proxy ? { dispatcher: proxy } : {}),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}
