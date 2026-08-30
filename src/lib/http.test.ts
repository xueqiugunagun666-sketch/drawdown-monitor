import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpPostJson, shouldBypassProxy } from './http.ts';

test('httpPostJson 把 body 序列化并带上 content-type', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ got: JSON.parse(body), ct: req.headers['content-type'], method: req.method }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await httpPostJson(`http://127.0.0.1:${port}/`, { a: 1 });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(parsed.got, { a: 1 });
    assert.match(parsed.ct, /application\/json/);
    assert.equal(parsed.method, 'POST');
  } finally {
    server.close();
  }
});

test('httpPostJson 支持 JSON-RPC 批量（数组 body）', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const arr = JSON.parse(body) as Array<{ id: number }>;
      res.writeHead(200, { 'content-type': 'application/json' });
      // 故意乱序返回，模拟真实节点行为
      res.end(JSON.stringify(arr.map((x) => ({ id: x.id, result: `r${x.id}` })).reverse()));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await httpPostJson(`http://127.0.0.1:${port}/`, [{ id: 1 }, { id: 2 }]);
    const parsed = JSON.parse(res.body) as Array<{ id: number }>;
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.id, 2, '节点可以乱序返回，调用方必须按 id 归位');
  } finally {
    server.close();
  }
});

test('httpPostJson 超时会中断而不是挂死', async () => {
  const server = createServer(() => { /* 故意不响应 */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(() => httpPostJson(`http://127.0.0.1:${port}/`, {}, 300));
  } finally {
    server.close();
  }
});

// 显式传入列表，不依赖跑测试时的环境变量
const NP = ['localhost', '127.0.0.1', '::1', '.local'];

test('NO_PROXY 命中时绕过代理', () => {
  assert.equal(shouldBypassProxy('http://127.0.0.1:7890/', NP), true);
  assert.equal(shouldBypassProxy('http://localhost:3000/', NP), true);
  assert.equal(shouldBypassProxy('http://foo.local/', NP), true, '.local 前缀条目应匹配子域');
});

test('NO_PROXY 未命中的外部地址仍走代理', () => {
  assert.equal(shouldBypassProxy('https://api.dexscreener.com/x', NP), false);
  assert.equal(shouldBypassProxy('https://openapi.gmgn.ai/x', NP), false);
});

test('NO_PROXY 条目不做子串匹配', () => {
  // "localhost" 不该匹配 "notlocalhost.com" —— 只认完整主机名或点分后缀
  assert.equal(shouldBypassProxy('https://notlocalhost.com/', NP), false);
});

test('NO_PROXY 为空时一律走代理', () => {
  assert.equal(shouldBypassProxy('http://127.0.0.1/', []), false);
});

test('NO_PROXY 含 * 时全部绕过', () => {
  assert.equal(shouldBypassProxy('https://api.dexscreener.com/x', ['*']), true);
});

test('非法 URL 不抛错', () => {
  assert.equal(shouldBypassProxy('not a url', NP), false);
});
