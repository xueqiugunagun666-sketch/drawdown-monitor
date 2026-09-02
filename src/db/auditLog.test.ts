/**
 * 重点不是「能不能插一行」，而是**事务边界**：
 * 审计写失败时主操作必须回滚。best-effort 的审计日志
 * 在最需要它的时候恰好可能是空的，那还不如不做。
 */
process.env.DATABASE_PATH = ':memory:';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from './migrate.ts';
import { getDb, getRawDb } from './index.ts';
import { recordAudit, listAudit } from './auditLog.ts';
import { tokens } from './schema.ts';

before(() => { runMigrations(); });

test('写一条能读回来，字段原样', () => {
  recordAudit({
    actorId: 'u1', actorName: 'pananiu', action: 'delete_token',
    targetType: 'token', targetId: 'bsc:0xdead', targetLabel: 'PONZI',
    detail: { note: '旧备注' },
  });
  const rows = listAudit(10);
  const r = rows.find((x) => x.targetId === 'bsc:0xdead');
  assert.ok(r, '刚写的记录没读到');
  assert.equal(r.actorName, 'pananiu');
  assert.equal(r.targetLabel, 'PONZI');
  assert.deepEqual(JSON.parse(r.detail!), { note: '旧备注' });
});

test('detail 允许为空', () => {
  recordAudit({
    actorId: 'u1', actorName: 'pananiu', action: 'update_rules',
    targetType: 'rules', targetId: null, targetLabel: null,
  });
  assert.ok(listAudit(10).some((x) => x.action === 'update_rules'));
});

test('listAudit 按时间倒序，最新的在前', () => {
  recordAudit({ actorId: 'u1', actorName: 'a', action: 'delete_token',
    targetType: 'token', targetId: 'first', targetLabel: 'F' });
  recordAudit({ actorId: 'u1', actorName: 'a', action: 'delete_token',
    targetType: 'token', targetId: 'second', targetLabel: 'S' });
  const rows = listAudit(2);
  assert.equal(rows[0]!.targetId, 'second', '最新的应该在最前面');
});

test('审计写失败时主操作回滚 —— 这是整个设计的关键', () => {
  const db = getDb();
  const raw = getRawDb();
  raw.prepare("INSERT INTO tokens (id,chain,address,added_at,note,tags,frozen,enabled,fail_count,visibility) VALUES ('x:1','bsc','0x1',1,'n','[]',0,1,0,'public')").run();

  const before = raw.prepare("SELECT COUNT(*) c FROM tokens WHERE id='x:1'").get() as { c: number };
  assert.equal(before.c, 1);

  assert.throws(() => {
    db.transaction(() => {
      raw.prepare("DELETE FROM tokens WHERE id='x:1'").run();
      // actor_name 是 NOT NULL，传 null 必然违反约束
      recordAudit({
        actorId: 'u1', actorName: null as unknown as string, action: 'delete_token',
        targetType: 'token', targetId: 'x:1', targetLabel: 'X',
      });
    });
  }, '审计写入失败时事务应当抛错');

  const after = raw.prepare("SELECT COUNT(*) c FROM tokens WHERE id='x:1'").get() as { c: number };
  assert.equal(after.c, 1, '审计写失败了，删除必须一并回滚');
});
