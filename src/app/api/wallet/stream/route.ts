/**
 * 报警的 SSE 推送。
 *
 * **为什么不是轮询**：后台标签页的 setInterval 会被浏览器节流到约一分钟，
 * 轮询会让报警延迟一分钟以上 —— 而暴涨报警慢一分钟基本就没意义了。
 * SSE 的消息不受这个节流影响，Notification 也能从后台标签页弹出。
 * （这个坑在 K 线图那里踩过：requestAnimationFrame 在非可见标签页根本不触发。）
 *
 * 服务端每 3 秒查一次本地 SQLite。这是本地文件读，成本可忽略，
 * 比让 worker 和 web 进程之间搞一套 IPC 简单得多。
 *
 * **断线必须能补**：浏览器重连时会自动带上 Last-Event-ID（上一条发出去的
 * 事件的 id），服务端从那里接着发。没有它，重连后 cursor 从"此刻"开始，
 * 断开期间发的报警永远不会补播、也不会进列表 —— 而这正是 9-03 FLETCH
 * 那次可能的丢法：一条报警确实写进了库，用户却什么都没听见。
 *
 * ready 事件也带 id，否则"连上之后一条报警都没发就断了"这种最常见的
 * 情况仍然没有游标可用。
 */
import { currentUser } from '../../../../lib/accountAuth.ts';
import { listPumpAlerts } from '../../../../db/walletRepo.ts';
import { enrichAlerts } from '../../../../db/alertEnrich.ts';
import { resolveCursor } from '../../../../lib/sseCursor.ts';

export const dynamic = 'force-dynamic';

const POLL_MS = 3000;
/** 心跳：防止中间代理（Caddy/云厂商 LB）掐断空闲连接 */
const HEARTBEAT_MS = 20_000;

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return new Response('需要登录个人账号', { status: 401 });

  const url = new URL(req.url);
  let cursor = resolveCursor(
    req.headers.get('last-event-id'),
    url.searchParams.get('since'),
    Math.floor(Date.now() / 1000),
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        const head = id === undefined ? '' : `id: ${id}\n`;
        try {
          controller.enqueue(encoder.encode(
            `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ));
        } catch {
          closed = true;
        }
      };

      // ready 带 id：这一条就是"我已经把 cursor 之前的都交代过了"的书面凭据，
      // 之后就算一条报警都没发就断了，重连也有得接
      send('ready', { cursor }, cursor);

      const tick = setInterval(() => {
        if (closed) return;
        let fresh;
        try {
          fresh = listPumpAlerts(u.id, cursor + 1);
        } catch {
          return;                       // 下一轮再试，不要因为一次读库失败就断流
        }
        if (fresh.length === 0) return;
        for (const a of fresh) cursor = Math.max(cursor, a.firedAt);
        // 必须补币名 —— 系统通知里没法复制粘贴，
        // 弹出一串 0x 等于没告诉用户是哪个币
        send('pump', enrichAlerts(fresh), cursor);
      }, POLL_MS);

      const beat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      const stop = () => {
        closed = true;
        clearInterval(tick);
        clearInterval(beat);
        try { controller.close(); } catch { /* 已关 */ }
      };
      req.signal.addEventListener('abort', stop);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 反代不要缓冲，否则消息会攒着一起发
      'x-accel-buffering': 'no',
    },
  });
}
