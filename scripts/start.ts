/**
 * 一条命令同时启动 worker 与 Web UI。
 *   npm start
 *
 * 不引入 concurrently 之类的依赖 —— 两个子进程用 node 自带的 spawn 就够了。
 * 任一进程退出就一起收掉，避免留下孤儿进程占着端口或数据库。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ?? '3000';

if (!existsSync(resolve(root, '.env'))) {
  console.log('提示: 没有 .env，Telegram 推送不可用（报警会记为投递失败并在看板顶部提示）。');
  console.log('      复制 .env.example 为 .env 并填入 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 即可。\n');
}

const children: ChildProcess[] = [];
let shuttingDown = false;

function run(name: string, color: string, cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${color}[${name}]\x1b[0m`;

  const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) => {
    let buf = '';
    stream?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) sink.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`\n${tag} 退出（code ${code}），正在停止另一个进程…`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  // 给 worker 一点时间收尾当前这轮
  setTimeout(() => {
    for (const c of children) if (!c.killed) c.kill('SIGKILL');
    process.exit(code);
  }, 6000).unref();
}

process.on('SIGINT', () => { console.log('\n收到 Ctrl-C，正在停止…'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run('worker', '\x1b[36m', npm, ['run', 'worker']);
run('web', '\x1b[35m', npm, ['run', 'dev']);

console.log(`\n看板: http://localhost:${PORT}\n按 Ctrl-C 停止\n`);
