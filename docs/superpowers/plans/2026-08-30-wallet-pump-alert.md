# 钱包暴涨异动报警 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动发现用户在四条 EVM 链上的代币持仓，监控价格，在暴涨到 2x/5x/10x 时用网页声音与系统通知叫醒用户，且各人的持仓互不可见。

**Architecture:** 四条 EVM 链共用一个自有 RPC 端点（路径里带 chain id）。用 `eth_getLogs` 按收款地址过滤 Transfer 事件发现"收过哪些代币"，撞上响应体积上限时自适应二分区间；再用 JSON-RPC 批量 `eth_call` 读 `balanceOf` 得到当前余额。过滤掉零余额与低流动性低成交的币之后，复用现有的价格轮询与 candle 存储，在 5m candle 序列上求四个窗口的涨幅倍数，用全局状态机分档触发，扇出给持有该币的用户，经 SSE 推到浏览器。

**Tech Stack:** TypeScript / Node 20+ / Next.js 15 App Router / better-sqlite3 + Drizzle / decimal.js / p-queue / node:test。**不新增任何依赖**——scrypt 用 Node 内置 `crypto`，ABI 编码手写选择器，不引入 viem/ethers。

**分期交付：** 五个阶段，每阶段结束提交一次 git。每阶段开始前先跟用户确认要动哪些文件。

---

## 文件结构

### 阶段 1 · 链上采集层（纯网络 + 纯函数，可脱离数据库独立测试）

| 文件 | 职责 |
|---|---|
| `src/lib/http.ts` | **改**：新增 `httpPostJson`，现有只有 GET |
| `src/lib/config.ts` | **改**：读 `EVM_RPC_BASE` 并注册进掩码表 |
| `src/sources/evmRpc.ts` | 新：JSON-RPC 客户端，链名 → chainId 映射，单次与批量调用，限流队列 |
| `src/sources/erc20.ts` | 新：`balanceOf`/`decimals` 选择器编码与返回值解码 |
| `src/sources/walletScan.ts` | 新：Transfer 日志发现代币 + 自适应二分 |
| `.env.example` | **改**：加 `EVM_RPC_BASE` |

### 阶段 2 · 数据模型与用户系统

| 文件 | 职责 |
|---|---|
| `src/db/schema.ts` | **改**：`users` / `sessions` / `wallets` / `holdings` / `pump_states` / `pump_alerts`，`tokens` 加 `visibility` |
| `src/db/migrate.ts` | **改**：新表 DDL + `tokens.visibility` 补列 |
| `src/lib/password.ts` | 新：scrypt 哈希与校验 |
| `src/lib/session.ts` | 新：会话 token 生成、哈希、校验 |
| `src/db/walletRepo.ts` | 新：钱包/持仓/报警的仓储函数（不塞进已有 568 行的 `repo.ts`） |
| `src/app/api/account/register/route.ts` 等 | 新：注册 / 登录 / 登出 |
| `src/middleware.ts` | **改**：`/wallet` 与 `/api/wallet` 额外要求个人会话 |

### 阶段 3 · 过滤与异动引擎（全部纯函数，全部有测试）

| 文件 | 职责 |
|---|---|
| `src/worker/pumpWindows.ts` | 新：在 5m candle 序列上求四窗口 × 两基准的倍数 |
| `src/worker/pumpState.ts` | 新：分档状态机、冷启动 seed、30 分钟去重择优 |
| `src/worker/holdingsFilter.ts` | 新：流动性/成交量门槛 + 滞回 |

### 阶段 4 · worker 集成

| 文件 | 职责 |
|---|---|
| `src/sources/dexscreenerBatch.ts` | 新：批量报价（一次最多 30 个地址） |
| `src/worker/walletScanner.ts` | 新：扫描调度，写 `holdings`，维护 `last_scanned_block` |
| `src/worker/pumpEngine.ts` | 新：串起窗口计算、状态机、去重、扇出、写 `pump_alerts` |
| `src/worker/worker.ts` | **改**：挂上钱包扫描与异动引擎两个循环 |

### 阶段 5 · 前端

| 文件 | 职责 |
|---|---|
| `src/app/wallet/page.tsx` 等 | 新：登录、钱包列表、持仓列表、报警历史 |
| `src/app/api/wallet/stream/route.ts` | 新：SSE 推送 |
| `src/lib/pumpSound.ts` | 新：声音解锁状态与播放 |

---

# 阶段 1 · 链上采集层

### Task 1.1: httpPostJson

**Files:**
- Modify: `src/lib/http.ts`（在 `httpGet` 之后追加）

- [ ] **Step 1: 写失败的测试**

Create `src/lib/http.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpPostJson } from './http.ts';

test('httpPostJson 把 body 序列化并带上 content-type', async () => {
  const server = (await import('node:http')).createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ got: JSON.parse(body), ct: req.headers['content-type'] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await httpPostJson(`http://127.0.0.1:${port}/`, { a: 1 });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(parsed.got, { a: 1 });
    assert.match(parsed.ct, /application\/json/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/lib/http.test.ts`
Expected: FAIL — `httpPostJson` 未导出

- [ ] **Step 3: 实现**

在 `src/lib/http.ts` 中 `httpGet` 之后加：

```ts
export async function httpPostJson(
  url: string,
  body: unknown,
  timeoutMs = 30_000,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      ...(dispatcher ? { dispatcher } : {}),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}
```

超时默认给 30 秒而不是 `httpGet` 的 15 秒：全链范围的 `eth_getLogs` 实测要 4.5 秒，
二分递归时更慢，15 秒会误杀。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/lib/http.test.ts`
Expected: PASS

- [ ] **Step 5: 把新测试文件纳入 test 脚本**

`package.json` 的 `test` 脚本已经是 `src/lib/*.test.ts` 通配，无需改动。
验证：`npm test` 应能看到 http.test.ts 的用例。

---

### Task 1.2: EVM RPC 客户端

**Files:**
- Create: `src/sources/evmRpc.ts`
- Create: `src/sources/evmRpc.test.ts`
- Modify: `src/lib/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: 先加配置项**

`src/lib/config.ts` 的 `Secrets` 接口加一行：

```ts
  evmRpcBase: string | undefined;
```

`getSecrets()` 里加：

```ts
    evmRpcBase: process.env.EVM_RPC_BASE || undefined,
```

并在 `registerSecret` 那一组里加：

```ts
  registerSecret(s.evmRpcBase);
```

**这一步不能省。** RPC 端点是用户的私有基础设施，注册后它出现在任何日志或
报错里都会被自动掩码。不注册的话，`eth_getLogs` 超时的报错会把完整 URL 打进日志。

`.env.example` 追加：

```
# EVM RPC 代理，四条链共用，路径末尾要带 chain id
# 形如 https://<host>/rpc/{chainId}；这里填到 /rpc 为止，不含 chainId
EVM_RPC_BASE=
```

- [ ] **Step 2: 写失败的测试**

Create `src/sources/evmRpc.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainIdOf, parseRpcResponse, parseBatchResponse } from './evmRpc.ts';

test('链名映射到 chain id', () => {
  assert.equal(chainIdOf('ethereum'), 1);
  assert.equal(chainIdOf('bsc'), 56);
  assert.equal(chainIdOf('base'), 8453);
  assert.equal(chainIdOf('robinhood'), 4663);
  assert.equal(chainIdOf('solana'), null);   // 本期不做，必须返回 null 而不是抛错
});

test('单条响应：正常返回 result', () => {
  assert.equal(parseRpcResponse('{"jsonrpc":"2.0","id":1,"result":"0x1237"}'), '0x1237');
});

test('单条响应：错误必须抛出且带上节点原文', () => {
  assert.throws(
    () => parseRpcResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Log response size exceeded"}}'),
    /Log response size exceeded/,
  );
});

test('批量响应按 id 归位，不依赖返回顺序', () => {
  const body = '[{"id":2,"result":"0xb"},{"id":1,"result":"0xa"}]';
  const out = parseBatchResponse(body, [1, 2]);
  assert.deepEqual(out, [
    { id: 1, result: '0xa', error: null },
    { id: 2, result: '0xb', error: null },
  ]);
});

test('批量响应里单条出错不影响其它条', () => {
  const body = '[{"id":1,"result":"0xa"},{"id":2,"error":{"code":-32000,"message":"execution reverted"}}]';
  const out = parseBatchResponse(body, [1, 2]);
  assert.equal(out[0].result, '0xa');
  assert.equal(out[0].error, null);
  assert.equal(out[1].result, null);
  assert.match(out[1].error!, /execution reverted/);
});

test('节点返回非 JSON（网关 502/504）要给出可读错误', () => {
  assert.throws(() => parseRpcResponse('error code: 504'), /非 JSON 响应/);
});
```

最后一条对应实测踩到的情况：网关过载时返回的是纯文本 `error code: 504`，
直接 `JSON.parse` 会抛出难读的 `SyntaxError: Unexpected token 'e'`。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx tsx --test src/sources/evmRpc.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现**

Create `src/sources/evmRpc.ts`:

```ts
/**
 * EVM JSON-RPC 客户端 —— 四条链共用一个代理端点，路径末尾是 chain id。
 *
 * 实测要点：
 *   - 端点接受 JSON-RPC 批量请求（请求体是数组），返回也是数组，
 *     但**返回顺序不保证**，必须按 id 归位。
 *   - eth_getLogs 的限制是**响应体积**，不是块跨度。带地址过滤时
 *     全链范围（0 → latest）一次就能查完，实测 4990 万块 4.5 秒。
 *     不带过滤时几千个块就会超限。
 *   - 网关过载返回的是纯文本 "error code: 504"，不是 JSON。
 */
import PQueue from 'p-queue';
import { httpPostJson } from '../lib/http.ts';
import { getSecrets } from '../lib/config.ts';
import { SourceError } from '../lib/errors.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('evm-rpc');
export const SOURCE_ID = 'evm-rpc';

/** 本期支持的链。solana 不在其中，调用方必须先判 null。 */
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, bsc: 56, base: 8453, robinhood: 4663,
};

export function chainIdOf(chain: string): number | null {
  return CHAIN_IDS[chain] ?? null;
}

export function supportedChains(): string[] {
  return Object.keys(CHAIN_IDS);
}

/** 单节点串行，避免把用户自己的端点打爆（实测公共节点两条并发就 429）。 */
const queue = new PQueue({ concurrency: 2 });

export interface BatchItem { id: number; result: string | null; error: string | null }

function requireJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'malformed',
      message: `非 JSON 响应: ${body.slice(0, 120)}`,
    });
  }
}

export function parseRpcResponse(body: string): string {
  const j = requireJson(body) as { result?: string; error?: { message?: string } };
  if (j.error) {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'http_error',
      message: j.error.message ?? JSON.stringify(j.error),
    });
  }
  if (j.result === undefined) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '响应既无 result 也无 error' });
  }
  return j.result;
}

export function parseBatchResponse(body: string, ids: number[]): BatchItem[] {
  const j = requireJson(body);
  if (!Array.isArray(j)) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '批量请求未返回数组' });
  }
  const byId = new Map<number, { result?: string; error?: { message?: string } }>();
  for (const item of j as Array<{ id: number }>) byId.set(item.id, item as never);
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { id, result: null, error: '响应中缺少该 id' };
    if (r.error) return { id, result: null, error: r.error.message ?? JSON.stringify(r.error) };
    return { id, result: r.result ?? null, error: null };
  });
}

function endpoint(chain: string): string {
  const base = getSecrets().evmRpcBase;
  if (!base) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: 'EVM_RPC_BASE 未配置' });
  }
  const id = chainIdOf(chain);
  if (id === null) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', chain, message: `不支持的链 ${chain}` });
  }
  return `${base.replace(/\/+$/, '')}/${id}`;
}

export async function rpc(chain: string, method: string, params: unknown[], timeoutMs = 60_000): Promise<string> {
  const url = endpoint(chain);
  return queue.add(async () => {
    const res = await httpPostJson(url, { jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
    if (res.status !== 200) {
      throw new SourceError({
        sourceId: SOURCE_ID, kind: 'http_error', chain,
        message: `HTTP ${res.status}: ${res.body.slice(0, 120)}`,
      });
    }
    return parseRpcResponse(res.body);
  }) as Promise<string>;
}

/** 批量调用。返回顺序与传入的 calls 一致。 */
export async function rpcBatch(
  chain: string, calls: Array<{ method: string; params: unknown[] }>, timeoutMs = 60_000,
): Promise<BatchItem[]> {
  if (calls.length === 0) return [];
  const url = endpoint(chain);
  const ids = calls.map((_, i) => i + 1);
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params }));
  return queue.add(async () => {
    const res = await httpPostJson(url, payload, timeoutMs);
    if (res.status !== 200) {
      throw new SourceError({
        sourceId: SOURCE_ID, kind: 'http_error', chain,
        message: `HTTP ${res.status}: ${res.body.slice(0, 120)}`,
      });
    }
    return parseBatchResponse(res.body, ids);
  }) as Promise<BatchItem[]>;
}

export async function blockNumber(chain: string): Promise<number> {
  return Number(BigInt(await rpc(chain, 'eth_blockNumber', [])));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test src/sources/evmRpc.test.ts`
Expected: PASS，6 个用例全绿

- [ ] **Step 6: 对真实端点做一次连通性检查**

Create `scripts/check-evm-rpc.ts`:

```ts
import { supportedChains, blockNumber } from '../src/sources/evmRpc.ts';

for (const chain of supportedChains()) {
  try {
    console.log(`${chain.padEnd(10)} 块高 ${await blockNumber(chain)}`);
  } catch (err) {
    console.log(`${chain.padEnd(10)} 失败: ${err instanceof Error ? err.message : err}`);
  }
}
```

`package.json` 加脚本：`"check:rpc": "tsx --env-file-if-exists=.env scripts/check-evm-rpc.ts"`

Run: `npm run check:rpc`
Expected: 四条链都打出块高。**同时确认输出里没有出现完整的 RPC URL**——
如果出现了说明 `registerSecret` 没生效，回到 Step 1 检查。

- [ ] **Step 7: 提交**

```bash
git add src/lib/config.ts src/lib/http.ts src/lib/http.test.ts src/sources/evmRpc.ts src/sources/evmRpc.test.ts scripts/check-evm-rpc.ts .env.example package.json
git commit -m "feat: EVM JSON-RPC 客户端，四链共用端点，批量按 id 归位"
```

---

### Task 1.3: ERC20 编码与解码

**Files:**
- Create: `src/sources/erc20.ts`
- Create: `src/sources/erc20.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/sources/erc20.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBalanceOf, SELECTOR_DECIMALS, decodeUint256, decodeUint8, toHumanAmount } from './erc20.ts';
import { Decimal } from '../lib/decimal.ts';

test('encodeBalanceOf = 4 字节选择器 + 32 字节左补零地址', () => {
  const data = encodeBalanceOf('0x0000000000000000000000000000000000001004');
  assert.equal(data.length, 2 + 8 + 64);            // '0x' + 选择器 + 参数
  assert.ok(data.startsWith('0x70a08231'));
  assert.ok(data.endsWith('0000000000000000000000000000000000001004'));
});

test('encodeBalanceOf 统一转小写，大小写地址产生相同 calldata', () => {
  const a = encodeBalanceOf('0xBB4CdB9CbD36B01bD1cBaEBF2De08d9173bc095c');
  const b = encodeBalanceOf('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
  assert.equal(a, b);
});

test('decimals 选择器固定', () => {
  assert.equal(SELECTOR_DECIMALS, '0x313ce567');
});

test('decodeUint256 对超过 2^53 的余额精确 —— 绝不能过 Number', () => {
  // 实测 BSC 上某地址的 CAKE 余额
  const raw = 78409586395585725488444n;
  const hex = '0x' + raw.toString(16).padStart(64, '0');
  assert.equal(decodeUint256(hex), '78409586395585725488444');
  // 反证：走 Number 会失真，说明这个测试确实在测东西
  assert.notEqual(String(Number(hex)), '78409586395585725488444');
});

test('decodeUint256 处理空返回（合约不存在 / 非 ERC20）', () => {
  assert.equal(decodeUint256('0x'), '0');
  assert.equal(decodeUint256(''), '0');
});

test('decodeUint8 读 decimals，读不到时返回 null 而不是猜 18', () => {
  assert.equal(decodeUint8('0x' + (18).toString(16).padStart(64, '0')), 18);
  assert.equal(decodeUint8('0x' + (6).toString(16).padStart(64, '0')), 6);
  assert.equal(decodeUint8('0x'), null);
});

test('toHumanAmount 用 Decimal 换算，不经过浮点', () => {
  // 1 个 18 位小数的代币
  assert.equal(toHumanAmount('1000000000000000000', 18).toString(), '1');
  // 极小额：浮点会给出 1e-18 的近似，Decimal 必须精确
  assert.equal(toHumanAmount('1', 18).toString(), '1e-18');
  // 大额且带小数，验证不丢精度
  assert.equal(toHumanAmount('78409586395585725488444', 18).toString(), '78409.586395585725488444');
});

test('toHumanAmount 在 decimals 未知时返回 null', () => {
  assert.equal(toHumanAmount('1000', null), null);
});
```

`decodeUint8` 读不到时返回 `null` 而不是默认 18 —— 这是第 4 条铁律。
猜 18 会让一个 6 位小数的代币余额被算大 10^12 倍，然后静静地进入监控，
最后报出一个荒谬的持仓价值。必须让调用方显式处理"不知道"。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/sources/erc20.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

Create `src/sources/erc20.ts`:

```ts
/**
 * ERC20 只读调用的手写编码 —— 项目里没有 viem/ethers，也不为这点事引入。
 *
 * 只涉及静态类型（address / uint256 / uint8），ABI 编码就是
 * "4 字节选择器 + 每个参数左补零到 32 字节"，没有动态类型的偏移量问题。
 * 实测已在 BSC 上验证：WBNB 与 CAKE 的 balanceOf、WBNB 的 decimals 均正确。
 */
import { Decimal } from '../lib/decimal.ts';

export const SELECTOR_BALANCE_OF = '0x70a08231';   // balanceOf(address)
export const SELECTOR_DECIMALS = '0x313ce567';     // decimals()
export const SELECTOR_SYMBOL = '0x95d89b41';       // symbol()

/** 地址左补零到 32 字节，用作 calldata 参数或 topic 过滤 */
export function padAddress(addr: string): string {
  return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

export function encodeBalanceOf(owner: string): string {
  return SELECTOR_BALANCE_OF + padAddress(owner);
}

/**
 * 32 字节 hex → 十进制字符串。走 BigInt，绝不经过 Number ——
 * 18 位小数的代币余额轻易超过 2^53。
 */
export function decodeUint256(hex: string): string {
  if (!hex || hex === '0x') return '0';
  try {
    return BigInt(hex).toString();
  } catch {
    return '0';
  }
}

/** decimals 读不到时返回 null，不猜默认值 —— 猜错会让余额差若干数量级 */
export function decodeUint8(hex: string): number | null {
  if (!hex || hex === '0x') return null;
  try {
    const v = Number(BigInt(hex));
    return v >= 0 && v <= 255 ? v : null;
  } catch {
    return null;
  }
}

/** 原始整数余额 + decimals → 人类数量。decimals 未知时返回 null。 */
export function toHumanAmount(raw: string, decimals: number | null): Decimal | null {
  if (decimals === null) return null;
  return new Decimal(raw).div(new Decimal(10).pow(decimals));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/sources/erc20.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/sources/erc20.ts src/sources/erc20.test.ts
git commit -m "feat: ERC20 只读调用的手写编解码，余额全程 BigInt/Decimal"
```

---

### Task 1.4: 持仓发现（自适应二分）

**这是阶段 1 里唯一有真实算法的部分，测试要写扎实。**

**Files:**
- Create: `src/sources/walletScan.ts`
- Create: `src/sources/walletScan.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/sources/walletScan.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFER_TOPIC, isRangeTooBig, discoverTokenAddresses, type GetLogs } from './walletScan.ts';

test('Transfer 事件签名是固定的 keccak256 值', () => {
  assert.equal(TRANSFER_TOPIC, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
});

test('isRangeTooBig 认得实测到的各家节点措辞', () => {
  // 以下四条都是实测采集的真实报文
  assert.ok(isRangeTooBig('Log response size exceeded. You can make eth_getLogs requests with up to a 10,000 block range'));
  assert.ok(isRangeTooBig('eth_getLogs is limited to a 10,000 range'));
  assert.ok(isRangeTooBig('logs matched by query exceeds limit of 10000'));
  assert.ok(isRangeTooBig('log query timed out'));
  assert.ok(isRangeTooBig('[QUICKNODE fallback] The request timedout after 4000 ms'));
});

test('isRangeTooBig 不把无关错误当成容量问题', () => {
  assert.equal(isRangeTooBig('execution reverted'), false);
  assert.equal(isRangeTooBig('invalid params'), false);
  assert.equal(isRangeTooBig('unauthorized'), false);
});

test('一次查得动时只调用一次', async () => {
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; return [{ address: '0xAAA' }, { address: '0xBBB' }]; };
  const out = await discoverTokenAddresses(getLogs, 0, 1000);
  assert.equal(calls, 1);
  assert.deepEqual([...out].sort(), ['0xaaa', '0xbbb']);
});

test('地址去重且统一小写', async () => {
  const getLogs: GetLogs = async () => [
    { address: '0xAbC' }, { address: '0xabc' }, { address: '0xABC' },
  ];
  const out = await discoverTokenAddresses(getLogs, 0, 10);
  assert.deepEqual([...out], ['0xabc']);
});

test('超限时二分，且子区间既不重叠也不遗漏', async () => {
  const seen: Array<[number, number]> = [];
  const getLogs: GetLogs = async (from, to) => {
    seen.push([from, to]);
    if (to - from > 500) throw new Error('Log response size exceeded');
    return [{ address: `0x${from}` }];
  };
  const out = await discoverTokenAddresses(getLogs, 0, 1000);
  // 首次 0..1000 失败，拆成 0..500 与 501..1000
  assert.deepEqual(seen, [[0, 1000], [0, 500], [501, 1000]]);
  assert.deepEqual([...out].sort(), ['0x0', '0x501']);
});

test('递归二分：需要拆两层时也正确', async () => {
  const ok: Array<[number, number]> = [];
  const getLogs: GetLogs = async (from, to) => {
    if (to - from > 250) throw new Error('Log response size exceeded');
    ok.push([from, to]);
    return [];
  };
  await discoverTokenAddresses(getLogs, 0, 1000);
  // 每个成功区间跨度都 <= 250，且首尾相接覆盖 0..1000
  assert.ok(ok.every(([f, t]) => t - f <= 250));
  ok.sort((a, b) => a[0] - b[0]);
  assert.equal(ok[0][0], 0);
  assert.equal(ok[ok.length - 1][1], 1000);
  for (let i = 1; i < ok.length; i++) assert.equal(ok[i][0], ok[i - 1][1] + 1);
});

test('区间已不可再分仍失败时抛错，不能无限递归', async () => {
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; throw new Error('Log response size exceeded'); };
  await assert.rejects(
    () => discoverTokenAddresses(getLogs, 100, 100),
    /不可再分/,
  );
  assert.ok(calls < 5, `不该反复重试，实际调用了 ${calls} 次`);
});

test('非容量类错误直接上抛，不触发二分', async () => {
  let calls = 0;
  const getLogs: GetLogs = async () => { calls++; throw new Error('unauthorized'); };
  await assert.rejects(() => discoverTokenAddresses(getLogs, 0, 1000), /unauthorized/);
  assert.equal(calls, 1);
});
```

倒数第二个测试是关键：二分的终止条件写错就是无限递归，把用户的 RPC 端点打死。
`calls < 5` 这个断言保证了它真的停下来了。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/sources/walletScan.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

Create `src/sources/walletScan.ts`:

```ts
/**
 * 从链上发现"这个地址收过哪些代币"。
 *
 * 原理：ERC20 的 Transfer 事件第三个 topic 是收款方。按它过滤，
 * 结果集就只剩这个地址相关的转账，很小 —— 实测 Robinhood 链上
 * fromBlock=0 到 latest 一次查完，1076 条日志 / 30 个代币 / 4.5 秒。
 *
 * 为什么这样够：你不可能持有一个从未收到过的代币，"收过"是"持有"的超集。
 * 卖掉的那些由后续 balanceOf 筛掉。
 *
 * 节点的限制是**响应体积**不是块跨度，所以不能固定按 N 个块分片
 * （那样在冷清的链上要跑几千次请求）。做法是先按全范围试，
 * 被拒绝了再对半拆，只在真正需要的地方细分。
 */
import { rpc } from './evmRpc.ts';
import { padAddress } from './erc20.ts';
import { makeLogger } from '../lib/log.ts';

const log = makeLogger('wallet-scan');

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * 各家节点拒绝大结果集时的措辞都不一样，这里的模式是实测采集的。
 * 漏掉一种就会让二分不触发，直接把错误抛给调用方，表现为"扫描总是失败"。
 */
const TOO_BIG = /exceed|limited to|too many|timed\s*out|timedout|response size|range/i;

export function isRangeTooBig(message: string): boolean {
  return TOO_BIG.test(message);
}

export interface LogEntry { address: string }
export type GetLogs = (from: number, to: number) => Promise<LogEntry[]>;

/**
 * 自适应二分。返回去重后的代币合约地址（全小写）。
 *
 * 终止条件：from === to 时不能再拆，此时仍失败就抛错。
 * 没有这个条件就是无限递归。
 */
export async function discoverTokenAddresses(
  getLogs: GetLogs, from: number, to: number, out = new Set<string>(),
): Promise<Set<string>> {
  try {
    const logs = await getLogs(from, to);
    for (const l of logs) out.add(l.address.toLowerCase());
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isRangeTooBig(msg)) throw err;
    if (from >= to) {
      throw new Error(`区间不可再分仍被节点拒绝 (block ${from}..${to}): ${msg}`);
    }
    const mid = Math.floor((from + to) / 2);
    await discoverTokenAddresses(getLogs, from, mid, out);
    await discoverTokenAddresses(getLogs, mid + 1, to, out);
    return out;
  }
}

/** 绑定到真实 RPC 的版本 */
export async function scanWalletTokens(
  chain: string, wallet: string, fromBlock: number, toBlock: number,
): Promise<Set<string>> {
  const topic = '0x' + padAddress(wallet);
  const getLogs: GetLogs = async (from, to) => {
    const raw = await rpc(chain, 'eth_getLogs', [{
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [TRANSFER_TOPIC, null, topic],
    }]) as unknown as LogEntry[];
    return Array.isArray(raw) ? raw : [];
  };
  const found = await discoverTokenAddresses(getLogs, fromBlock, toBlock);
  log.info(`${chain} ${wallet.slice(0, 10)}… block ${fromBlock}-${toBlock}: 发现 ${found.size} 个代币`);
  return found;
}
```

**注意 `rpc()` 的返回类型**：`evmRpc.rpc` 声明返回 `string`（因为多数方法返回 hex 字符串），
但 `eth_getLogs` 返回的是数组。Step 4 要修掉这个类型谎言。

- [ ] **Step 4: 修正 rpc 的返回类型**

`src/sources/evmRpc.ts` 里把 `rpc` 的签名改成泛型，不要用 `as unknown as` 糊过去：

```ts
export async function rpc<T = string>(chain: string, method: string, params: unknown[], timeoutMs = 60_000): Promise<T> {
```

同时 `parseRpcResponse` 改成：

```ts
export function parseRpcResponse<T = string>(body: string): T {
  const j = requireJson(body) as { result?: T; error?: { message?: string } };
  if (j.error) {
    throw new SourceError({
      sourceId: SOURCE_ID, kind: 'http_error',
      message: j.error.message ?? JSON.stringify(j.error),
    });
  }
  if (j.result === undefined) {
    throw new SourceError({ sourceId: SOURCE_ID, kind: 'malformed', message: '响应既无 result 也无 error' });
  }
  return j.result;
}
```

`blockNumber` 保持 `rpc<string>(...)`，`scanWalletTokens` 里改成 `rpc<LogEntry[]>(...)`，
去掉 `as unknown as`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test src/sources/walletScan.test.ts && npx tsx --test src/sources/evmRpc.test.ts`
Expected: 两个文件全绿

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 7: 对真实链做一次端到端验证**

扩展 `scripts/check-evm-rpc.ts`，接受一个地址参数：

```ts
import { supportedChains, blockNumber } from '../src/sources/evmRpc.ts';
import { scanWalletTokens } from '../src/sources/walletScan.ts';

const addr = process.argv[2];
for (const chain of supportedChains()) {
  try {
    const head = await blockNumber(chain);
    if (!addr) { console.log(`${chain.padEnd(10)} 块高 ${head}`); continue; }
    const t0 = Date.now();
    const tokens = await scanWalletTokens(chain, addr, 0, head);
    console.log(`${chain.padEnd(10)} 块高 ${head}  代币 ${tokens.size} 个  ${Date.now() - t0}ms`);
  } catch (err) {
    console.log(`${chain.padEnd(10)} 失败: ${err instanceof Error ? err.message : err}`);
  }
}
```

Run: `npm run check:rpc -- 0x8156EDd920Be55E364B49Cb95d2b3327d16bEF60`
Expected: Robinhood 链应返回约 30 个代币（这是实测过的基准值）。
其余三条链可能因该地址无活动返回 0，属正常。

- [ ] **Step 8: 提交**

```bash
git add src/sources/walletScan.ts src/sources/walletScan.test.ts src/sources/evmRpc.ts scripts/check-evm-rpc.ts
git commit -m "feat: 按收款地址过滤 Transfer 发现持仓，响应超限时自适应二分"
```

---

**阶段 1 完成检查：**

- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 无错误
- [ ] `npm run check:rpc` 四条链都能返回块高
- [ ] 日志与脚本输出里**没有出现完整的 RPC URL**

---

# 阶段 2 · 数据模型与用户系统

### Task 2.1: 建表

**Files:** Modify `src/db/schema.ts`, `src/db/migrate.ts`

- [ ] **Step 1: 在 `src/db/migrate.ts` 的 DDL 字符串末尾追加**

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL, address TEXT NOT NULL, label TEXT,
  last_scanned_block INTEGER, last_scan_at INTEGER, last_scan_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  UNIQUE(user_id, chain, address)
);
CREATE TABLE IF NOT EXISTS holdings (
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL, balance TEXT NOT NULL, decimals INTEGER,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  monitored INTEGER NOT NULL DEFAULT 0, filter_reason TEXT,
  below_since_ts INTEGER,
  PRIMARY KEY (wallet_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_holdings_token ON holdings(token_id);
CREATE TABLE IF NOT EXISTS pump_states (
  token_id TEXT NOT NULL, timeframe TEXT NOT NULL, basis TEXT NOT NULL,
  level REAL NOT NULL, state TEXT NOT NULL, last_fired_at INTEGER,
  PRIMARY KEY (token_id, timeframe, basis, level)
);
CREATE TABLE IF NOT EXISTS pump_alerts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL, timeframe TEXT NOT NULL, basis TEXT NOT NULL,
  level REAL NOT NULL, multiple TEXT NOT NULL,
  price_usd TEXT, base_price_usd TEXT, balance TEXT, value_usd TEXT,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pump_alerts_user ON pump_alerts(user_id, fired_at);
```

`below_since_ts` 是滞回用的：记录"跌破退出门槛"的起始时刻，
持续够 30 分钟才真的退出监控（见 spec §6）。

- [ ] **Step 2: `ADDED_COLUMNS` 数组加一行**

```ts
  ['tokens', 'visibility', "TEXT NOT NULL DEFAULT 'public'"],
```

默认 `public` 保证现有的看板代币行为不变。

- [ ] **Step 3: 在 `src/db/schema.ts` 补上对应的 Drizzle 定义**

照现有 `sqliteTable` 的写法逐表补齐，列名与上面 DDL 一一对应。
`tokens` 表加 `visibility: text('visibility').default('public').notNull()`。

- [ ] **Step 4: 跑迁移**

Run: `npm run db:migrate`
Expected: 打印 `已补列 tokens.visibility`，无报错

- [ ] **Step 5: 验证既有数据没被破坏**

```bash
sqlite3 data/monitor.db "select count(*) from tokens; select count(*) from tokens where visibility='public'; select name from sqlite_master where type='table' and name in ('users','wallets','holdings','pump_states','pump_alerts');"
```

Expected: 两个 count 相等（所有既有代币都是 public），五张新表都在

- [ ] **Step 6: 提交**

```bash
git add src/db/schema.ts src/db/migrate.ts
git commit -m "feat: 钱包监控的数据模型，tokens 加 visibility 隔离看板与钱包"
```

---

### Task 2.2: 密码与会话

**Files:** Create `src/lib/password.ts`, `src/lib/password.test.ts`, `src/lib/session.ts`, `src/lib/session.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/lib/password.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.ts';

test('同一密码两次哈希结果不同（盐不同）', async () => {
  const a = await hashPassword('hunter2');
  const b = await hashPassword('hunter2');
  assert.notEqual(a, b);
});

test('正确密码校验通过，错误密码不通过', async () => {
  const h = await hashPassword('hunter2');
  assert.equal(await verifyPassword('hunter2', h), true);
  assert.equal(await verifyPassword('hunter3', h), false);
});

test('哈希串里不含明文密码', async () => {
  const h = await hashPassword('correct-horse-battery-staple');
  assert.ok(!h.includes('correct-horse'));
});

test('损坏的哈希串返回 false 而不是抛错', async () => {
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', ''), false);
});
```

Create `src/lib/session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSessionToken, hashToken, SESSION_TTL_SECONDS } from './session.ts';

test('会话 token 足够长且每次不同', () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);          // 32 字节 base64url
});

test('hashToken 稳定且不可逆', () => {
  const t = newSessionToken();
  assert.equal(hashToken(t), hashToken(t));
  assert.ok(!hashToken(t).includes(t));
});

test('TTL 是有限的', () => {
  assert.ok(SESSION_TTL_SECONDS > 0 && SESSION_TTL_SECONDS <= 90 * 86400);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/lib/password.test.ts src/lib/session.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/lib/password.ts`**

```ts
/**
 * 密码哈希 —— scrypt，用 Node 内置 crypto，不引入 bcrypt/argon2 依赖。
 *
 * 存储格式：scrypt$N$r$p$salt_b64$hash_b64
 * 校验用 timingSafeEqual，避免按字节比较导致的时序侧信道。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  pw: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number },
) => Promise<Buffer>;

const N = 16384, r = 8, p = 1, KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, sN, sr, sp, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scryptAsync(password, salt, expected.length, {
      N: Number(sN), r: Number(sr), p: Number(sp),
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 实现 `src/lib/session.ts`**

```ts
/**
 * 个人会话 —— 与全站共用的 ACCESS_TOKEN 是两回事，叠加在它之上。
 * 库里只存 token 的哈希：数据库泄露时拿不到可用的会话凭证。
 */
import { randomBytes, createHash } from 'node:crypto';

export const SESSION_COOKIE = 'wallet_session';
export const SESSION_TTL_SECONDS = 30 * 86400;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test src/lib/password.test.ts src/lib/session.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 6: 提交**

```bash
git add src/lib/password.ts src/lib/password.test.ts src/lib/session.ts src/lib/session.test.ts
git commit -m "feat: scrypt 密码哈希与会话 token，库里只存哈希"
```

---

### Task 2.3: 钱包仓储

**Files:** Create `src/db/walletRepo.ts`

单独建文件，不塞进已有 568 行的 `repo.ts`。导出以下函数，
全部照 `repo.ts` 现有的 better-sqlite3 prepared statement 写法：

```ts
// 用户
createUser(name: string, passwordHash: string): { id: string }
findUserByName(name: string): { id: string; name: string; passwordHash: string } | null
// 会话
createSession(userId: string, tokenHash: string, expiresAt: number): void
findUserBySessionHash(tokenHash: string, now: number): { id: string; name: string } | null
deleteSession(tokenHash: string): void
purgeExpiredSessions(now: number): number
// 钱包
addWallet(userId: string, chain: string, address: string, label: string | null): { id: string }
listWallets(userId: string): WalletRow[]
listAllEnabledWallets(): WalletRow[]                    // worker 用，跨用户
updateWalletScanState(id: string, block: number, at: number, error: string | null): void
removeWallet(userId: string, id: string): boolean       // 必须带 userId 条件
// 持仓
upsertHolding(walletId: string, tokenId: string, balance: string, decimals: number | null, now: number): void
listHoldings(userId: string): HoldingRow[]
setHoldingMonitored(walletId: string, tokenId: string, monitored: boolean, reason: string | null, belowSinceTs: number | null): void
usersHoldingToken(tokenId: string): Array<{ userId: string; walletId: string; balance: string; decimals: number | null }>
monitoredTokenIds(): string[]
// 报警
insertPumpAlert(row: PumpAlertRow): void
listPumpAlerts(userId: string, sinceTs: number): PumpAlertRow[]
pumpAlertsAfterId(userId: string, afterFiredAt: number): PumpAlertRow[]   // SSE 用
```

**每一个接受 `userId` 的读写都必须把它放进 WHERE 子句**，不能先查后比。
`removeWallet` 尤其重要：`DELETE FROM wallets WHERE id=? AND user_id=?`，
少了第二个条件就成了任意用户删任意钱包。

- [ ] **Step 1: 写越权测试**

Create `src/db/walletRepo.test.ts`，用内存库（`DATABASE_PATH=:memory:`）建两个用户，
断言：

```ts
test('A 用户删不掉 B 用户的钱包', () => {
  const a = createUser('alice', 'h'), b = createUser('bob', 'h');
  const w = addWallet(b.id, 'bsc', '0xabc', null);
  assert.equal(removeWallet(a.id, w.id), false);
  assert.equal(listWallets(b.id).length, 1);
});

test('listWallets 只返回自己的', () => {
  const a = createUser('alice2', 'h'), b = createUser('bob2', 'h');
  addWallet(a.id, 'bsc', '0x1', null);
  addWallet(b.id, 'bsc', '0x2', null);
  assert.equal(listWallets(a.id).length, 1);
  assert.equal(listWallets(a.id)[0].address, '0x1');
});

test('listHoldings 不泄露他人持仓', () => {
  // 两人持有同一个代币时，各自只看到自己那条
});
```

- [ ] **Step 2-4:** 跑测试确认失败 → 实现 → 跑测试确认通过

- [ ] **Step 5: 提交**

```bash
git add src/db/walletRepo.ts src/db/walletRepo.test.ts
git commit -m "feat: 钱包仓储，所有读写按 user_id 隔离"
```

---

### Task 2.4: 注册 / 登录 / 中间件

**Files:** Create `src/app/api/account/{register,login,logout}/route.ts`, `src/lib/accountAuth.ts`；Modify `src/middleware.ts`

- [ ] **Step 1: `src/lib/accountAuth.ts`**

```ts
/** 从请求 cookie 解出当前个人账号；未登录返回 null。所有钱包 API 的唯一身份入口。 */
export function currentUser(req: Request): { id: string; name: string } | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (!m?.[1]) return null;
  return findUserBySessionHash(hashToken(decodeURIComponent(m[1])), Math.floor(Date.now() / 1000));
}
```

**钱包相关的 API 路由一律用它取 `userId`，绝不从请求体或查询参数读 user_id。**

- [ ] **Step 2: 三个路由**

- `POST /api/account/register` — body `{name, password}`。用户名走 `sanitizeName`
  （复用 `src/lib/user.ts`），密码长度至少 8。用户名已存在返回 409。
  成功后直接建会话并 set cookie。
- `POST /api/account/login` — 用户名或密码错误一律返回同一句"用户名或密码错误"，
  不区分（否则可以枚举用户名）。
- `POST /api/account/logout` — 删会话，清 cookie。

cookie 设置：`httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_SECONDS`，
`secure` 在生产为 true。**不要手动 `encodeURIComponent`**——
`NextResponse.cookies.set` 已经会编码，手动再编一次会产生 `%25E8%2580…`
这种双重编码（这个坑在用户名 cookie 上踩过一次）。

- [ ] **Step 3: 中间件**

`src/middleware.ts` 的 `PUBLIC_PATHS` 不动。在共享口令校验通过之后追加：

```ts
  // 钱包区在全站口令之上，再要求个人会话
  if (pathname.startsWith('/wallet') || pathname.startsWith('/api/wallet')) {
    const session = req.cookies.get('wallet_session')?.value;
    if (!session) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
      }
      const url = req.nextUrl.clone();
      url.pathname = '/wallet/login';
      return NextResponse.redirect(url);
    }
  }
```

中间件跑在 edge runtime，**不能查数据库**，所以这里只检查 cookie 存在与否；
真正的会话有效性由各路由里的 `currentUser()` 判定。这是有意的两层：
中间件挡掉未登录的浏览，路由做真正的鉴权。

`/wallet/login` 要加进 `PUBLIC_PATHS` 的钱包例外，否则会重定向到自己。

- [ ] **Step 4: 手工验证**

```bash
npm run build && npm run start:prod
```

- 未登录访问 `/wallet` → 跳到 `/wallet/login`
- 注册 → 自动登录 → 能进 `/wallet`
- 换一个浏览器隐身窗口注册第二个账号 → 看不到第一个账号的钱包
- 登出 → `/wallet` 再次跳登录

- [ ] **Step 5: 提交**

```bash
git add src/app/api/account src/lib/accountAuth.ts src/middleware.ts
git commit -m "feat: 个人账号注册登录，钱包区在全站口令之上再加一层"
```

**阶段 2 完成检查：** `npm test` 全绿；`npm run typecheck` 无错误；两个账号互相看不到对方钱包。

---

# 阶段 3 · 过滤与异动引擎

**本阶段全部是纯函数，不碰数据库、不碰网络。** 所有判定逻辑都在这里，
阶段 4 只负责把数据喂进来、把结果写出去。这样切分是为了让最容易出错的部分
可以被穷举测试。

### Task 3.1: 窗口倍数计算

**Files:** Create `src/worker/pumpWindows.ts`, `src/worker/pumpWindows.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/worker/pumpWindows.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  WINDOW_SECONDS, TIMEFRAMES, windowStartTs, computeMultiples, type Candle5m,
} from './pumpWindows.ts';

/** 造一串 5m candle，ts 从 startTs 起每 300 秒一根 */
function series(startTs: number, rows: Array<[o: string, l: string]>): Candle5m[] {
  return rows.map(([o, l], i) => ({ ts: startTs + i * 300, o, l }));
}

const NOW = 1_700_000_100;                    // 不在 300 边界上，故意的
const CUR = Math.floor(NOW / 300) * 300;      // 当前这根 candle 的 ts

test('窗口起点：5m 就是当前这根 candle', () => {
  assert.equal(windowStartTs('5m', NOW), CUR);
});

test('窗口起点：其余窗口按 5m 根数回推', () => {
  assert.equal(windowStartTs('1h', NOW), CUR - 3300);    // 12 根
  assert.equal(windowStartTs('6h', NOW), CUR - 21300);   // 72 根
  assert.equal(windowStartTs('24h', NOW), CUR - 86100);  // 288 根
});

test('每个窗口恰好覆盖 WINDOW_SECONDS/300 根 candle', () => {
  for (const tf of TIMEFRAMES) {
    const n = (CUR - windowStartTs(tf, NOW)) / 300 + 1;
    assert.equal(n, WINDOW_SECONDS[tf] / 300, `${tf} 应覆盖 ${WINDOW_SECONDS[tf] / 300} 根`);
  }
});

test('low 取窗口内最低的 l，open 取最老那根的 o', () => {
  const candles = series(CUR - 3300, [
    ['10', '8'], ['11', '9'], ['12', '5'], ['13', '11'],
  ]);
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  const h1low = out.find((r) => r.timeframe === '1h' && r.basis === 'low')!;
  const h1open = out.find((r) => r.timeframe === '1h' && r.basis === 'open')!;
  assert.equal(h1low.base.toString(), '5');
  assert.equal(h1low.multiple.toString(), '4');
  assert.equal(h1open.base.toString(), '10');
  assert.equal(h1open.multiple.toString(), '2');
});

test('5m 窗口只看当前这一根', () => {
  const candles = series(CUR - 900, [
    ['1', '1'], ['1', '1'], ['1', '1'], ['4', '4'],   // 最后一根是当前
  ]);
  const out = computeMultiples(candles, new Decimal('8'), NOW);
  const m5 = out.find((r) => r.timeframe === '5m' && r.basis === 'open')!;
  assert.equal(m5.base.toString(), '4');
  assert.equal(m5.multiple.toString(), '2');
});

test('窗口内没有 candle 时跳过该窗口，不产出结果', () => {
  const candles = series(CUR, [['10', '10']]);       // 只有当前这根
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  assert.ok(out.some((r) => r.timeframe === '5m'));
  assert.ok(!out.some((r) => r.timeframe === '24h'), '24h 窗口没有数据，不该产出');
});

test('base 为 0 时跳过，不能除零', () => {
  const candles = series(CUR, [['0', '0']]);
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  assert.equal(out.length, 0);
});

test('base 为 null 的 candle 不参与计算', () => {
  const candles: Candle5m[] = [
    { ts: CUR - 300, o: null, l: null },
    { ts: CUR, o: '10', l: '10' },
  ];
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  const m5 = out.find((r) => r.timeframe === '5m' && r.basis === 'open')!;
  assert.equal(m5.base.toString(), '10');
});

test('价格低于基准时倍数小于 1，不报错也不截断', () => {
  const candles = series(CUR, [['10', '10']]);
  const out = computeMultiples(candles, new Decimal('5'), NOW);
  assert.equal(out.find((r) => r.basis === 'open')!.multiple.toString(), '0.5');
});

test('memecoin 量级的极小价格不丢精度', () => {
  const candles = series(CUR, [['0.000000000001', '0.000000000001']]);
  const out = computeMultiples(candles, new Decimal('0.000000000002'), NOW);
  assert.equal(out.find((r) => r.basis === 'open')!.multiple.toString(), '2');
});

test('low 恒不大于 open（同一根 candle 内）', () => {
  const candles = series(CUR - 3300, [['10', '3'], ['11', '4'], ['9', '2']]);
  const out = computeMultiples(candles, new Decimal('20'), NOW);
  const low = out.find((r) => r.timeframe === '1h' && r.basis === 'low')!;
  const open = out.find((r) => r.timeframe === '1h' && r.basis === 'open')!;
  assert.ok(low.base.lte(open.base), 'low 基准必然不高于 open 基准');
  assert.ok(low.multiple.gte(open.multiple), '因此 low 的倍数必然不低于 open');
});
```

最后一条是不变量测试：`low` 基准恒 ≤ `open` 基准，所以 `low` 的倍数恒 ≥ `open` 的。
如果哪天改动破坏了这个关系，一定是逻辑错了。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/worker/pumpWindows.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

Create `src/worker/pumpWindows.ts`:

```ts
/**
 * 在 5m candle 序列上求四个窗口 × 两个基准的涨幅倍数。
 *
 * 窗口定义：以当前这根（未收盘的）5m candle 为终点，往回数
 * WINDOW_SECONDS/300 根。因此 5m 窗口就是当前这一根自己。
 * 用根数而不是"now 减去秒数"来划界，是为了让每个窗口的 candle 数量恒定，
 * 不会因为 now 落在 candle 中间而时多时少。
 *
 * 两个基准：
 *   low  —— 窗口内所有 candle 的最低价，"从低点拉起了几倍"
 *   open —— 窗口内最老那根的开盘价，"这段时间净涨了几倍"
 * low 基准恒不高于 open 基准，所以 low 的倍数恒不低于 open 的。
 */
import { Decimal } from '../lib/decimal.ts';

export type PumpTimeframe = '5m' | '1h' | '6h' | '24h';
export type PumpBasis = 'low' | 'open';

export const WINDOW_SECONDS: Record<PumpTimeframe, number> = {
  '5m': 300, '1h': 3600, '6h': 21600, '24h': 86400,
};

export const TIMEFRAMES: PumpTimeframe[] = ['5m', '1h', '6h', '24h'];

const SLOT = 300;

export interface Candle5m { ts: number; o: string | null; l: string | null }

export interface WindowResult {
  timeframe: PumpTimeframe;
  basis: PumpBasis;
  base: Decimal;
  multiple: Decimal;
}

/** 窗口起点（含）。终点恒为当前这根 candle。 */
export function windowStartTs(tf: PumpTimeframe, now: number): number {
  const current = Math.floor(now / SLOT) * SLOT;
  return current - (WINDOW_SECONDS[tf] - SLOT);
}

export function computeMultiples(
  candles: Candle5m[], price: Decimal, now: number,
): WindowResult[] {
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const out: WindowResult[] = [];

  for (const tf of TIMEFRAMES) {
    const start = windowStartTs(tf, now);
    const inWindow = sorted.filter((c) => c.ts >= start);
    if (inWindow.length === 0) continue;          // 没数据就不判，不是判为 0

    // open：最老那根的开盘价；跳过 o 为空的（回填段可能缺）
    const firstWithOpen = inWindow.find((c) => c.o !== null && c.o !== '');
    if (firstWithOpen?.o) {
      const base = new Decimal(firstWithOpen.o);
      if (base.gt(0)) out.push({ timeframe: tf, basis: 'open', base, multiple: price.div(base) });
    }

    // low：窗口内最低的 l
    let low: Decimal | null = null;
    for (const c of inWindow) {
      if (c.l === null || c.l === '') continue;
      const v = new Decimal(c.l);
      if (!v.gt(0)) continue;                      // 0 或负数不是有效价格
      if (low === null || v.lt(low)) low = v;
    }
    if (low) out.push({ timeframe: tf, basis: 'low', base: low, multiple: price.div(low) });
  }

  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/worker/pumpWindows.test.ts`
Expected: PASS，11 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/worker/pumpWindows.ts src/worker/pumpWindows.test.ts
git commit -m "feat: 四窗口两基准的涨幅倍数计算，全程 Decimal"
```

---

### Task 3.2: 分档状态机与去重

**Files:** Create `src/worker/pumpState.ts`, `src/worker/pumpState.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/worker/pumpState.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../lib/decimal.ts';
import {
  LEVELS, REARM_RATIO, DEDUP_WINDOW_SECONDS,
  initialPumpState, seedPumpState, evaluatePump, pickWinner, suppressedByRecent,
  type PendingFire,
} from './pumpState.ts';

const d = (s: string | number) => new Decimal(s);

test('档位就是 2 / 5 / 10', () => {
  assert.deepEqual([...LEVELS], [2, 5, 10]);
});

test('ARMED 状态下达到档位就触发', () => {
  const r = evaluatePump(initialPumpState(), { multiple: d(2), level: 2, now: 100 });
  assert.equal(r.fire, true);
  assert.equal(r.next.state, 'FIRED');
  assert.equal(r.next.lastFiredAt, 100);
});

test('差一点点不触发', () => {
  const r = evaluatePump(initialPumpState(), { multiple: d('1.999'), level: 2, now: 100 });
  assert.equal(r.fire, false);
  assert.equal(r.next.state, 'ARMED');
});

test('已 FIRED 时继续在高位不重复触发', () => {
  let s = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  for (let t = 200; t < 2000; t += 100) {
    const r = evaluatePump(s, { multiple: d(3), level: 2, now: t });
    assert.equal(r.fire, false, `t=${t} 不该重复触发`);
    s = r.next;
  }
});

test('回落到档位 80% 以上不重新武装（滞回区内）', () => {
  const fired = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  const r = evaluatePump(fired, { multiple: d('1.9'), level: 2, now: 200 });  // 1.9 > 2*0.8
  assert.equal(r.next.state, 'FIRED');
});

test('回落到档位 80% 以下才重新武装，且重新武装本身不触发', () => {
  const fired = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  const r = evaluatePump(fired, { multiple: d('1.5'), level: 2, now: 200 });  // 1.5 < 2*0.8
  assert.equal(r.fire, false);
  assert.equal(r.next.state, 'ARMED');
});

test('重新武装后再涨上去会再次触发', () => {
  let s = evaluatePump(initialPumpState(), { multiple: d(3), level: 2, now: 100 }).next;
  s = evaluatePump(s, { multiple: d('1.5'), level: 2, now: 200 }).next;
  const r = evaluatePump(s, { multiple: d('2.1'), level: 2, now: 300 });
  assert.equal(r.fire, true);
});

test('REARM_RATIO 就是 0.8', () => {
  assert.equal(REARM_RATIO, 0.8);
});

// ---- 冷启动 seed：这是上次踩过的坑的同一个机制 ----

test('新币首次进入监控时已在 6 倍：2x 与 5x 直接置 FIRED，不补报', () => {
  assert.equal(seedPumpState(d(6), 2).state, 'FIRED');
  assert.equal(seedPumpState(d(6), 5).state, 'FIRED');
  assert.equal(seedPumpState(d(6), 10).state, 'ARMED');
});

test('seed 出来的 FIRED 不带 lastFiredAt —— 它从没真的报过', () => {
  assert.equal(seedPumpState(d(6), 2).lastFiredAt, null);
});

test('seed 成 FIRED 之后涨到更高档位仍会触发', () => {
  const s = seedPumpState(d(6), 10);              // 10x 档还是 ARMED
  const r = evaluatePump(s, { multiple: d(11), level: 10, now: 100 });
  assert.equal(r.fire, true, '这正是 seed 的目的：不补报旧的，但新的要报');
});

test('回归：已经在 6 倍的币加入后，一次 tick 不应产生任何报警', () => {
  // 对应 commit 6699db0 那个"新代币连推 75/80/85"的反向情形
  const fires = LEVELS.map((level) => {
    const s = seedPumpState(d(6), level);
    return evaluatePump(s, { multiple: d(6), level, now: 100 }).fire;
  });
  assert.deepEqual(fires, [false, false, false]);
});

// ---- 去重择优 ----

const fire = (tf: PendingFire['timeframe'], mult: string, level = 2): PendingFire => ({
  tokenId: 't', timeframe: tf, basis: 'low', level, multiple: d(mult), at: 100,
});

test('多条触发里取倍数最高的', () => {
  const w = pickWinner([fire('24h', '3'), fire('1h', '7'), fire('5m', '4')])!;
  assert.equal(w.multiple.toString(), '7');
  assert.equal(w.timeframe, '1h');
});

test('倍数相同时取窗口更短的', () => {
  const w = pickWinner([fire('24h', '5'), fire('5m', '5'), fire('6h', '5')])!;
  assert.equal(w.timeframe, '5m');
});

test('空数组返回 null', () => {
  assert.equal(pickWinner([]), null);
});

test('30 分钟内已报过就压制', () => {
  assert.equal(DEDUP_WINDOW_SECONDS, 1800);
  assert.equal(suppressedByRecent(1000, 1000 + 1799), true);
  assert.equal(suppressedByRecent(1000, 1000 + 1800), false);
  assert.equal(suppressedByRecent(null, 999999), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/worker/pumpState.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

Create `src/worker/pumpState.ts`:

```ts
/**
 * 暴涨分档状态机。与 stateMachine.ts（回撤）是镜像关系但方向相反，
 * 且没有 confirm_ticks —— 暴涨要的是快，慢两拍就没意义了。
 *
 * 状态是**全局的**，键为 (token_id, timeframe, basis, level)，不按用户分。
 * 价格变动是全局事实，只有"通知谁"是每人不同的。
 * 这顺带解决了一个边界情况：B 用户新加的钱包持有一个已经是 FIRED 的币，
 * 状态机不会重复触发，B 自然收不到追溯报警。
 */
import { Decimal } from '../lib/decimal.ts';
import { WINDOW_SECONDS, type PumpTimeframe, type PumpBasis } from './pumpWindows.ts';

export const LEVELS = [2, 5, 10] as const;

/** 回落到档位的这个比例以下才重新武装。防止在 2.0 附近抖动导致反复触发。 */
export const REARM_RATIO = 0.8;

/** 同一个币在这个时长内只发一条报警 */
export const DEDUP_WINDOW_SECONDS = 1800;

export interface PumpSnapshot {
  state: 'ARMED' | 'FIRED';
  lastFiredAt: number | null;
}

export function initialPumpState(): PumpSnapshot {
  return { state: 'ARMED', lastFiredAt: null };
}

/**
 * 冷启动：一个币首次进入监控时调用。
 * 此刻已经达标的档位直接置 FIRED —— 不为"它进来之前就涨过"这件事补报。
 *
 * lastFiredAt 保持 null：它从没真的发出过报警，历史记录不该声称发过。
 */
export function seedPumpState(multiple: Decimal, level: number): PumpSnapshot {
  if (multiple.gte(level)) return { state: 'FIRED', lastFiredAt: null };
  return initialPumpState();
}

export interface PumpEvalParams {
  multiple: Decimal;
  level: number;
  now: number;
}

export function evaluatePump(
  prev: PumpSnapshot, { multiple, level, now }: PumpEvalParams,
): { fire: boolean; next: PumpSnapshot } {
  if (prev.state === 'FIRED') {
    const rearmAt = new Decimal(level).mul(REARM_RATIO);
    if (multiple.lt(rearmAt)) {
      return { fire: false, next: { state: 'ARMED', lastFiredAt: prev.lastFiredAt } };
    }
    return { fire: false, next: prev };
  }
  if (multiple.gte(level)) {
    return { fire: true, next: { state: 'FIRED', lastFiredAt: now } };
  }
  return { fire: false, next: prev };
}

export interface PendingFire {
  tokenId: string;
  timeframe: PumpTimeframe;
  basis: PumpBasis;
  level: number;
  multiple: Decimal;
  at: number;
}

/**
 * 同一个币的一波行情会让多个窗口先后达标。只发一条：
 * 倍数最高的优先；倍数相同时窗口更短的优先
 * （5 分钟涨 2 倍比 24 小时涨 2 倍更值得看）。
 *
 * 注意：没被选中的那些，状态机照样要置 FIRED，只是不产生通知。
 * 不置的话，去重窗口一过就会全部重放。
 */
export function pickWinner(fires: PendingFire[]): PendingFire | null {
  if (fires.length === 0) return null;
  return fires.reduce((best, f) => {
    const c = f.multiple.comparedTo(best.multiple);
    if (c > 0) return f;
    if (c < 0) return best;
    return WINDOW_SECONDS[f.timeframe] < WINDOW_SECONDS[best.timeframe] ? f : best;
  });
}

export function suppressedByRecent(lastAlertAt: number | null, now: number): boolean {
  return lastAlertAt !== null && now - lastAlertAt < DEDUP_WINDOW_SECONDS;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/worker/pumpState.test.ts`
Expected: PASS，17 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add src/worker/pumpState.ts src/worker/pumpState.test.ts
git commit -m "feat: 暴涨分档状态机，冷启动 seed 不追溯补报，同币 30 分钟择优"
```

---

### Task 3.3: 持仓过滤与滞回

**Files:** Create `src/worker/holdingsFilter.ts`, `src/worker/holdingsFilter.test.ts`

- [ ] **Step 1: 写失败的测试**

Create `src/worker/holdingsFilter.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, evaluateFilter, type FilterState } from './holdingsFilter.ts';

const armed: FilterState = { monitored: true, belowSinceTs: null };
const idle: FilterState = { monitored: false, belowSinceTs: null };
const th = DEFAULT_THRESHOLDS;

test('默认门槛是 $5,000 流动性 + $10,000 日成交', () => {
  assert.equal(th.minLiquidityUsd, 5000);
  assert.equal(th.minVolume24hUsd, 10000);
});

test('两个条件都达标才进入监控', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 6000, volume24hUsd: 12000 }, 100, th);
  assert.equal(r.monitored, true);
  assert.equal(r.reason, null);
});

test('流动性够但成交量不够，不进入，且说明是哪条不够', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 50000, volume24hUsd: 500 }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason!, /成交/);
});

test('成交量够但流动性不够，不进入', () => {
  const r = evaluateFilter(idle, { liquidityUsd: 100, volume24hUsd: 999999 }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason!, /流动性/);
});

test('滞回：已监控的币跌到 $4,000（低于入门槛但高于退出线）不退出', () => {
  const r = evaluateFilter(armed, { liquidityUsd: 4000, volume24hUsd: 12000 }, 100, th);
  assert.equal(r.monitored, true, '5000*0.6=3000 才是退出线，4000 在滞回区内');
  assert.equal(r.belowSinceTs, null);
});

test('跌破退出线要持续 30 分钟才退出', () => {
  const t0 = 1000;
  const step1 = evaluateFilter(armed, { liquidityUsd: 500, volume24hUsd: 12000 }, t0, th);
  assert.equal(step1.monitored, true, '刚跌破还不退出');
  assert.equal(step1.belowSinceTs, t0);

  const step2 = evaluateFilter(step1, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 1799, th);
  assert.equal(step2.monitored, true, '不满 30 分钟还不退出');

  const step3 = evaluateFilter(step2, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 1800, th);
  assert.equal(step3.monitored, false, '满 30 分钟才退出');
});

test('跌破后恢复，计时清零，不会累计', () => {
  const t0 = 1000;
  const dipped = evaluateFilter(armed, { liquidityUsd: 500, volume24hUsd: 12000 }, t0, th);
  assert.equal(dipped.belowSinceTs, t0);

  const recovered = evaluateFilter(dipped, { liquidityUsd: 8000, volume24hUsd: 12000 }, t0 + 60, th);
  assert.equal(recovered.belowSinceTs, null, '恢复后必须清零');
  assert.equal(recovered.monitored, true);

  // 再次跌破，计时应从头开始而不是接着 t0 算
  const again = evaluateFilter(recovered, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 120, th);
  assert.equal(again.belowSinceTs, t0 + 120);
  const stillIn = evaluateFilter(again, { liquidityUsd: 500, volume24hUsd: 12000 }, t0 + 1900, th);
  assert.equal(stillIn.monitored, true, '从第二次跌破算起还不满 30 分钟');
});

test('报价缺失时保持原状态，并明确标出，不静默降级', () => {
  const r = evaluateFilter(armed, { liquidityUsd: null, volume24hUsd: null }, 100, th);
  assert.equal(r.monitored, true, '数据缺失不等于流动性归零，不能因此踢出监控');
  assert.match(r.reason!, /报价缺失/);
});

test('报价缺失时未监控的币也不会被误判为达标', () => {
  const r = evaluateFilter(idle, { liquidityUsd: null, volume24hUsd: null }, 100, th);
  assert.equal(r.monitored, false);
  assert.match(r.reason!, /报价缺失/);
});
```

倒数第二条是第 4 条铁律的直接体现：报价拿不到时，**既不能当作 0 把币踢出监控**
（那会让一个正常的币因为一次接口抖动而静默失联），**也不能当作达标**。
保持原状态并把原因写出来，让用户在页面上看得见。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/worker/holdingsFilter.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

Create `src/worker/holdingsFilter.ts`:

```ts
/**
 * 决定一个持仓的代币要不要进入价格监控。
 *
 * 这一层是整个功能的生死线，不是优化项：实测拿一个活跃地址查索引器，
 * 返回 7,984 个代币，其中只有 368 个有价格。不过滤，轮询预算当场爆掉，
 * 而且空投垃圾币恰恰是波动最疯的，会占据绝大部分报警名额。
 *
 * 门槛必须有滞回。一个恰好卡在 $5,000 附近的币会反复进出监控集，
 * 而每次重新进入都会触发一次冷启动 seed，把状态机重置 ——
 * 结果是它涨到 2 倍时可能一次都不报，也可能报十次。
 */
export interface FilterThresholds {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  /** 退出门槛 = 进入门槛 × 这个比例 */
  exitRatio: number;
  /** 跌破退出门槛后要持续这么久才真的退出 */
  exitSustainSeconds: number;
}

export const DEFAULT_THRESHOLDS: FilterThresholds = {
  minLiquidityUsd: 5000,
  minVolume24hUsd: 10000,
  exitRatio: 0.6,
  exitSustainSeconds: 1800,
};

export interface FilterInput {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
}

export interface FilterState {
  monitored: boolean;
  belowSinceTs: number | null;
}

export interface FilterResult extends FilterState {
  reason: string | null;
}

export function evaluateFilter(
  prev: FilterState, q: FilterInput, now: number, th: FilterThresholds = DEFAULT_THRESHOLDS,
): FilterResult {
  // 报价缺失：既不当 0 也不当达标，保持原状态并标明
  if (q.liquidityUsd === null || q.volume24hUsd === null) {
    return { monitored: prev.monitored, belowSinceTs: prev.belowSinceTs, reason: '报价缺失，判定暂缓' };
  }

  const { liquidityUsd: liq, volume24hUsd: vol } = q;

  if (!prev.monitored) {
    const liqOk = liq >= th.minLiquidityUsd;
    const volOk = vol >= th.minVolume24hUsd;
    if (liqOk && volOk) return { monitored: true, belowSinceTs: null, reason: null };
    const missing: string[] = [];
    if (!liqOk) missing.push(`流动性 $${Math.round(liq).toLocaleString()} < $${th.minLiquidityUsd.toLocaleString()}`);
    if (!volOk) missing.push(`24h 成交 $${Math.round(vol).toLocaleString()} < $${th.minVolume24hUsd.toLocaleString()}`);
    return { monitored: false, belowSinceTs: null, reason: missing.join('，') };
  }

  // 已在监控：用更低的退出门槛判，形成滞回区
  const exitLiq = th.minLiquidityUsd * th.exitRatio;
  const exitVol = th.minVolume24hUsd * th.exitRatio;
  const below = liq < exitLiq || vol < exitVol;

  if (!below) return { monitored: true, belowSinceTs: null, reason: null };

  const since = prev.belowSinceTs ?? now;
  if (now - since >= th.exitSustainSeconds) {
    return {
      monitored: false, belowSinceTs: null,
      reason: `流动性/成交持续低于退出线超过 ${th.exitSustainSeconds / 60} 分钟`,
    };
  }
  return { monitored: true, belowSinceTs: since, reason: '低于退出线，观察中' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/worker/holdingsFilter.test.ts`
Expected: PASS，10 个用例全绿

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/worker/holdingsFilter.ts src/worker/holdingsFilter.test.ts
git commit -m "feat: 持仓过滤门槛与滞回，报价缺失时不静默降级"
```

**阶段 3 完成检查：** 三个模块共 38 个用例全绿；`npm run typecheck` 无错误。
此时所有判定逻辑已完成且可脱离网络与数据库验证。

---

# 阶段 4 · worker 集成

### Task 4.1: 批量报价

**Files:** Create `src/sources/dexscreenerBatch.ts`, `src/sources/dexscreenerBatch.test.ts`

钱包币只需要"价格 + 流动性 + 24h 量"，不需要主池选举与全池聚合，
因此走 `/tokens/v1/{chain}/{addr1},{addr2},...` 批量接口，一次最多 30 个地址。

实测返回形状（BSC，三个地址）：数组，每项含 `baseToken.address`、
`priceUsd`、`liquidity.usd`、`volume.h24`，每个代币回一个池。

- [ ] **Step 1: 写失败的测试**

Create `src/sources/dexscreenerBatch.test.ts`。核心用例：

```ts
test('把响应按 baseToken.address 归位，大小写不敏感', () => {
  const rows = parseBatchQuotes(JSON.stringify([
    { baseToken: { address: '0xAAA' }, priceUsd: '1.5', liquidity: { usd: 9000 }, volume: { h24: 20000 } },
  ]), ['0xaaa']);
  assert.equal(rows.get('0xaaa')!.priceUsd, '1.5');
});

test('请求的地址在响应里缺失时，标记为缺失而不是当作零', () => {
  const rows = parseBatchQuotes('[]', ['0xaaa', '0xbbb']);
  assert.equal(rows.get('0xaaa'), undefined);
  // 调用方据此写 filter_reason='报价缺失'，而不是把流动性当 0
});

test('同一代币返回多个池时取流动性最高的', () => {
  const rows = parseBatchQuotes(JSON.stringify([
    { baseToken: { address: '0xa' }, priceUsd: '1', liquidity: { usd: 100 }, volume: { h24: 1 } },
    { baseToken: { address: '0xa' }, priceUsd: '2', liquidity: { usd: 900 }, volume: { h24: 2 } },
  ]), ['0xa']);
  assert.equal(rows.get('0xa')!.priceUsd, '2');
});

test('价格保持字符串，不转 number', () => {
  const rows = parseBatchQuotes(JSON.stringify([
    { baseToken: { address: '0xa' }, priceUsd: '0.000000000001234', liquidity: { usd: 9000 }, volume: { h24: 2 } },
  ]), ['0xa']);
  assert.equal(rows.get('0xa')!.priceUsd, '0.000000000001234');
  assert.equal(typeof rows.get('0xa')!.priceUsd, 'string');
});
```

最后一条守的是第 1 条铁律：价格从入口进来就是字符串，中途不许过 `Number`。

- [ ] **Step 2-4:** 跑测试确认失败 → 实现 → 跑测试确认通过

实现要点：
- 每批 30 个地址，超出分批，复用 `src/sources/dexscreener.ts` 里已有的 p-queue
  （不要另起队列，否则两条通道会互相把对方打限流 —— CoinGecko 上踩过这个坑）
- 缺失的地址收进 `SourceError` 的 `missing` 字段，kind 用 `partial_response`
- **不要因为部分缺失就整批失败**：拿到的先用，缺的标记出来

- [ ] **Step 5: 提交** `git commit -m "feat: DexScreener 批量报价，缺失地址显式标记不静默"`

---

### Task 4.2: 钱包扫描调度

**Files:** Create `src/worker/walletScanner.ts`

职责：遍历所有启用的钱包，发现代币 → 读余额 → 写 `holdings` → 更新 `last_scanned_block`。

```ts
export async function scanWallet(wallet: WalletRow, now: number): Promise<void>
export async function scanAllWallets(now: number): Promise<void>
```

要点：

1. **增量扫描**：`fromBlock = wallet.lastScannedBlock ?? 0`，`toBlock = 当前块高`。
   首次全量，之后只扫新块。扫描成功后才更新 `last_scanned_block` ——
   中途失败必须能重来，不能把没扫完的区间标记成已扫。

2. **发现是增量的，余额是全量的**：新块里只能发现"新收到的代币"，
   但**已知代币的余额可能变了**（卖出、转出）。所以每轮都要对
   `holdings` 里该钱包的全部代币重读 `balanceOf`，不只是新发现的。
   漏了这条，卖掉的币会永远留在监控里。

3. **余额归零就删**：`balanceOf` 返回 0 的从 `holdings` 删除。

4. **decimals 只读一次**：已知 decimals 的不重复读，省一半调用。
   读不到 decimals 的代币**不进入监控**，`filter_reason` 记 `decimals 读取失败`
   （见 Task 1.3：猜 18 会让余额差若干数量级）。

5. **失败要写进 `wallets.last_scan_error`**（已掩码），并在 UI 上显示。
   连续失败不能只打日志 —— 用户会以为在正常监控。

6. 扫描间隔 12 分钟，与价格轮询分开的独立循环。

- [ ] **Step 1: 写测试**（注入假的 `scanWalletTokens` 与 `rpcBatch`，不打真实网络）

```ts
test('已知代币即使不在新块里也会重读余额', async () => { /* ... */ });
test('余额归零的代币从 holdings 移除', async () => { /* ... */ });
test('扫描失败时不推进 last_scanned_block', async () => { /* ... */ });
test('decimals 读不到的代币不进入监控且写明原因', async () => { /* ... */ });
```

- [ ] **Step 2-4:** 确认失败 → 实现 → 确认通过
- [ ] **Step 5: 提交** `git commit -m "feat: 钱包扫描调度，增量发现全量对账"`

---

### Task 4.3: 异动引擎

**Files:** Create `src/worker/pumpEngine.ts`

把阶段 3 的三个纯函数串起来：

```ts
export async function runPumpTick(now: number): Promise<void>
```

流程：

1. 取所有 `monitored=1` 的 token_id（跨用户去重 —— 两人持有同一个币只算一次）
2. 批量报价（Task 4.1）
3. 对每个币跑 `evaluateFilter`，更新 `holdings.monitored / filter_reason / below_since_ts`
4. 读该币最近 288 根 5m candle，跑 `computeMultiples`
5. 对 4 窗口 × 2 基准 × 3 档位共 24 个组合：
   - `pump_states` 里没有记录 → 用 `seedPumpState` 建，**本轮不产生报警**
   - 有记录 → 跑 `evaluatePump`，收集 `fire=true` 的
   - **无论是否被去重选中，`next` 状态一律写回**（否则去重窗口一过就重放）
6. `pickWinner` 选一条；`suppressedByRecent` 判是否压制
7. 选中的那条，用 `usersHoldingToken` 扇出，给每个持有者写一行 `pump_alerts`，
   带上该用户自己的余额与持仓价值

**第 5 步里"seed 的那一轮不报警"是关键**，对应上次那个连推三档的坑。

- [ ] **Step 1: 写集成测试**（内存库 + 假报价）

```ts
test('新币首次进入监控当轮不产生任何报警，即使已经在 6 倍', async () => { /* ... */ });
test('两个用户持有同一个币，各自收到一条报警', async () => { /* ... */ });
test('未被选中的窗口状态也被写回，30 分钟后不会重放', async () => { /* ... */ });
test('报警里的持仓价值是各自的，不串号', async () => { /* ... */ });
```

- [ ] **Step 2-4:** 确认失败 → 实现 → 确认通过
- [ ] **Step 5: 提交** `git commit -m "feat: 异动引擎，全局状态机按持有者扇出"`

---

### Task 4.4: 挂进 worker

**Files:** Modify `src/worker/worker.ts`

加两个独立循环：钱包扫描 12 分钟一轮，异动判定 2 分钟一轮。

- [ ] **Step 1: 两个循环都必须是 fire-and-forget，不能 await 阻塞主轮询**

这是踩过的坑：之前把原生币历史回填写成 `await`，CoinGecko 限流时
把价格轮询整整堵了两分多钟。钱包扫描要打几十上百个 RPC 请求，更不能堵。

- [ ] **Step 2: 钱包币的价格轮询要和看板分开**

看板 30 秒一轮，钱包币 2 分钟一轮。轮询主循环取 token 时按
`visibility` 分流，不要一把全取。

- [ ] **Step 3: 容量实测**

Run: `npm run bench`（现有脚本），确认加入钱包币后单轮耗时仍在周期内。
若超了，先降钱包币轮询频率，不要动看板。

- [ ] **Step 4: 提交** `git commit -m "feat: worker 挂上钱包扫描与异动判定两个独立循环"`

**阶段 4 完成检查：** `npm test` 全绿；worker 跑 30 分钟无未捕获异常；
`npm run bench` 显示单轮耗时在周期内。

---

# 阶段 5 · 前端

### Task 5.1: SSE 推送

**Files:** Create `src/app/api/wallet/stream/route.ts`

- 每 3 秒查一次 `pump_alerts`（本地 SQLite 读，成本可忽略），有新的就推
- 游标用 `fired_at`，客户端重连时带上，不会漏
- `export const dynamic = 'force-dynamic'`，否则 Next 会尝试静态化
- 心跳：每 20 秒发一个注释帧，防止中间代理掐断空闲连接

**为什么是 SSE 不是轮询**：后台标签页的定时器会被浏览器节流到约 1 分钟，
轮询会让报警延迟一分钟以上。SSE 的消息不受这个节流影响。
（这个坑在 K 线图那里踩过：`requestAnimationFrame` 在非可见标签页根本不触发。）

- [ ] 手工验证：开着页面切到别的标签，从别的终端往库里插一条 `pump_alerts`，
      确认 3 秒内收到。

### Task 5.2: 声音与通知

**Files:** Create `src/lib/pumpSound.ts`, `src/components/SoundToggle.tsx`

```ts
export type SoundStatus = 'locked' | 'ready' | 'denied';
export function unlockAudio(): Promise<SoundStatus>   // 必须在用户点击的事件处理里调
export function playPumpSound(): void
export async function requestNotificationPermission(): Promise<NotificationPermission>
```

要点：

- 浏览器禁止未经交互的自动播放。`unlockAudio` 必须在真实点击事件里调用一次，
  创建并 `resume()` 一个 `AudioContext`
- **状态必须在 UI 上显眼**：`locked` 时顶部显示醒目横幅"声音未开启，
  暴涨时不会有提示音"。用户以为开着其实没声音，是这个功能最危险的失效方式
- 声音用 `AudioContext` 合成，不加音频文件（免去打包与加载失败两类问题）
- 系统通知与声音同时发；通知点击后聚焦到该币的详情

- [ ] 手工验证：刷新页面后横幅出现；点开启后消失；切到别的标签页时仍能弹通知并出声。

### Task 5.3: 钱包页面

**Files:** `src/app/wallet/page.tsx`、`login/`、`WalletList.tsx`、`HoldingsTable.tsx`、`PumpAlertFeed.tsx`

跟随现有视觉规范：层级参考 `src/components/TokenRow.tsx`，配色用 `src/lib/severity.ts`。
**注意 `tailwind.config.ts` 的 `content` 必须覆盖新增目录**——
之前 `src/lib` 没在里面，导致 severity 的颜色被静默 purge 掉，
构建通过、测试通过、页面也渲染，只是颜色没了。

页面内容：

- 钱包列表：链、地址（截断显示）、上次扫描时间、扫描错误（红色显著）
- 持仓表：币、余额、价值、四个窗口的当前倍数、是否在监控、未监控原因
- 报警流：时间、币、倍数、窗口、基准（"从低点" / "净涨"）
- 顶部状态条：声音状态、上次扫描时间、RPC 健康

持仓价值**显示**给本人 —— 数据不出服务器，没有隐去的必要。

- [ ] 手工验证：两个账号互相看不到对方的钱包、持仓、报警。

- [ ] **提交** `git commit -m "feat: 钱包页面、SSE 推送、声音与系统通知"`

**阶段 5 完成检查：** 构建通过；两账号隔离；声音未授权时有醒目提示；
后台标签页能收到通知。

---

# 自查

**规格覆盖**：spec 的 §4 身份 → 阶段 2；§5 采集 → 阶段 1 + Task 4.2；
§6 过滤 → Task 3.3 + 4.3；§7 引擎 → Task 3.1/3.2 + 4.3；§8 容量 → Task 4.1/4.4；
§9 触达 → Task 5.1/5.2；§10 数据模型 → Task 2.1；§11 界面 → Task 5.3；
§12 不做的 → 计划里没有出现 Solana、Telegram、暴跌、波动率分位数。

**类型一致性**：`PumpTimeframe` / `PumpBasis` 在 `pumpWindows.ts` 定义，
`pumpState.ts` 从它 import，不重复声明。`FilterState` 的字段名
（`monitored` / `belowSinceTs`）与 `holdings` 表列名（`monitored` / `below_since_ts`）对应。
`Candle5m` 的 `o` / `l` 为 `string | null`，与 `candles` 表的 TEXT 可空一致。

**已知留白**：Task 4.1–4.4 与阶段 5 的测试用例只给了名字和断言意图，
没有写出完整实现体 —— 这几处依赖阶段 1–3 落地后的真实类型签名，
写死反而会与实际代码对不上。**执行到该任务时，先补完测试代码再动实现。**
