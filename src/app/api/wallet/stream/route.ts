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
 */
import { currentUser } from '../../../../lib/accountAuth.ts';
import { listPumpAlerts } from '../../../../db/walletRepo.ts';

export const dynamic = 'force-dynamic';

const POLL_MS = 3000;
/** 心跳：防止中间代理（Caddy/云厂商 LB）掐断空闲连接 */
const HEARTBEAT_MS = 20_000;

export async function GET(req: Request) {
  const u = currentUser(req);
  if (!u) return new Response('需要登录个人账号', { status: 401 });

  const url = new URL(req.url);
  // 客户端重连时带上游标，不会漏；不带就从此刻开始
  let cursor = Number(url.searchParams.get('since') ?? 0) || Math.floor(Date.now() / 1000);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send('ready', { cursor });

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
        send('pump', fresh);
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
