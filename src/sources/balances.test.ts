import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBalanceCalls, mapBalanceResults, chunkByToken, CALLS_PER_REQUEST, type BatchFn } from './balances.ts';
import { readBalancesWith } from './balances.ts';

const W = '0x0000000000000000000000000000000000001004';

test('每批调用数上限是 50', () => {
  assert.equal(CALLS_PER_REQUEST, 50);
});

test('decimals 已知的代币只发 balanceOf，不重复读 decimals', () => {
  const calls = buildBalanceCalls(W, ['0xa', '0xb'], new Map([['0xa', 18]]));
  // 0xa 只有余额；0xb 有余额 + decimals
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((c) => c.kind === 'decimals').length, 1);
  assert.equal(calls.find((c) => c.kind === 'decimals')?.token, '0xb');
});

test('decimals 全未知时每个代币两次调用', () => {
  assert.equal(buildBalanceCalls(W, ['0xa', '0xb'], new Map()).length, 4);
});

test('calldata 用的是钱包地址而不是代币地址', () => {
  // 传错参数会读到代币合约自己持有的余额，是个安静的错误：
  // 有数字返回、不报错、但完全不是你的持仓
  const calls = buildBalanceCalls(W, ['0xtoken'], new Map([['0xtoken', 18]]));
  assert.ok(calls[0]!.data.endsWith('0000000000000000000000000000000000001004'));
  assert.ok(!calls[0]!.data.includes('token'));
});

test('mapBalanceResults 把余额与 decimals 合到一起', () => {
  const calls = buildBalanceCalls(W, ['0xa'], new Map());
  const results = calls.map((c) => ({
    id: 0,
    result: c.kind === 'balance'
      ? '0x' + (1234n).toString(16).padStart(64, '0')
      : '0x' + (6).toString(16).padStart(64, '0'),
    error: null,
  }));
  const m = mapBalanceResults(calls, results, new Map());
  assert.equal(m.get('0xa')?.balance, '1234');
  assert.equal(m.get('0xa')?.decimals, 6);
});

test('已知的 decimals 会被带进结果，不因本轮没读而丢失', () => {
  const known = new Map([['0xa', 8]]);
  const calls = buildBalanceCalls(W, ['0xa'], known);
  const results = calls.map(() => ({ id: 0, result: '0x' + (99n).toString(16).padStart(64, '0'), error: null }));
  assert.equal(mapBalanceResults(calls, results, known).get('0xa')?.decimals, 8);
});

test('单个 eth_call 出错时该代币标为读取失败，不影响其它代币', () => {
  const calls = buildBalanceCalls(W, ['0xa', '0xb'], new Map([['0xa', 18], ['0xb', 18]]));
  const results = [
    { id: 0, result: '0x' + (5n).toString(16).padStart(64, '0'), error: null },
    { id: 1, result: null, error: 'execution reverted' },
  ];
  const m = mapBalanceResults(calls, results, new Map([['0xa', 18], ['0xb', 18]]));
  assert.equal(m.get('0xa')?.balance, '5');
  assert.equal(m.get('0xb'), undefined, '出错的代币不该出现在结果里');
});

test('decimals 读不到时保留余额但 decimals 为 null', () => {
  const calls = buildBalanceCalls(W, ['0xa'], new Map());
  const results = calls.map((c) => ({
    id: 0,
    result: c.kind === 'balance' ? '0x' + (7n).toString(16).padStart(64, '0') : '0x',
    error: null,
  }));
  const m = mapBalanceResults(calls, results, new Map());
  assert.equal(m.get('0xa')?.balance, '7');
  assert.equal(m.get('0xa')?.decimals, null, '读不到就是 null，绝不猜 18');
});

test('超大余额不失真', () => {
  const huge = 78409586395585725488444n;
  const calls = buildBalanceCalls(W, ['0xa'], new Map([['0xa', 18]]));
  const m = mapBalanceResults(calls, [
    { id: 0, result: '0x' + huge.toString(16).padStart(64, '0'), error: null },
  ], new Map([['0xa', 18]]));
  assert.equal(m.get('0xa')?.balance, huge.toString());
});

test('readBalancesWith 按 50 个调用一批切分', async () => {
  const batches: number[] = [];
  const fake: BatchFn = async (_chain, calls) => {
    batches.push(calls.length);
    return calls.map(() => ({ id: 0, result: '0x' + (1n).toString(16).padStart(64, '0'), error: null }));
  };
  // 60 个代币、decimals 全已知 -> 60 个调用 -> 切成 50 + 10
  const known = new Map<string, number | null>();
  const tokens = Array.from({ length: 60 }, (_, i) => { known.set(`0x${i}`, 18); return `0x${i}`; });
  const m = await readBalancesWith(fake, 'bsc', W, tokens, known);
  assert.deepEqual(batches, [50, 10]);
  assert.equal(m.size, 60);
});

test('readBalancesWith 空代币列表不发请求', async () => {
  let called = false;
  const fake: BatchFn = async () => { called = true; return []; };
  const m = await readBalancesWith(fake, 'bsc', W, [], new Map());
  assert.equal(called, false);
  assert.equal(m.size, 0);
});

test('切批不能把同一代币的 balanceOf 与 decimals 劈到两批里', async () => {
  // decimals 全未知 -> 每个代币 2 个调用。若按调用数硬切，
  // 第 25 个代币的 balance 落在第一批、decimals 落在第二批，
  // 结果就是它的 decimals 永远读不出来 —— 而且是静默的
  const fake: BatchFn = async (_c, calls) =>
    calls.map((c) => {
      const data = (c.params as Array<{ data: string }>)[0]!.data;
      return {
        id: 0,
        result: data === '0x313ce567'
          ? '0x' + (6).toString(16).padStart(64, '0')
          : '0x' + (42n).toString(16).padStart(64, '0'),
        error: null,
      };
    });
  // 关键：混入一个 decimals 已知的代币（只占 1 个调用），
  // 让后面的调用流错位，边界就会落在某个代币的两个调用中间。
  // 全部未知时每个代币恰好 2 个调用，按 50 切正好落在代币边界上，测不出问题
  const tokens = Array.from({ length: 40 }, (_, i) => `0x${i}`);
  const known = new Map<string, number | null>([['0x0', 18]]);
  const m = await readBalancesWith(fake, 'bsc', W, tokens, known);
  assert.equal(m.size, 40);
  const bad = tokens.slice(1).filter((t) => m.get(t)?.decimals !== 6);
  assert.deepEqual(bad, [], `这些代币的 decimals 被切批丢掉了: ${bad.join(',')}`);
});

test('chunkByToken 每批不超过上限，且不拆散同一代币', () => {
  const planned = buildBalanceCalls(W, Array.from({ length: 40 }, (_, i) => `0x${i}`),
    new Map<string, number | null>([['0x0', 18]]));
  const chunks = chunkByToken(planned);
  assert.equal(chunks.flat().length, planned.length, '不能丢调用');
  for (const c of chunks) {
    assert.ok(c.length <= CALLS_PER_REQUEST, `批大小 ${c.length} 超限`);
    // 同一代币的调用必须全在同一批
    const tokensHere = new Set(c.map((x) => x.token));
    for (const t of tokensHere) {
      const inChunk = c.filter((x) => x.token === t).length;
      const inAll = planned.filter((x) => x.token === t).length;
      assert.equal(inChunk, inAll, `代币 ${t} 被拆散了`);
    }
  }
});

test('单个代币的调用组本身超限时也不会死循环', () => {
  // 防御：即使某代币的调用数超过 limit，也要能产出而不是无限循环
  const planned = buildBalanceCalls(W, ['0xa'], new Map());
  assert.equal(chunkByToken(planned, 1).flat().length, planned.length);
});
