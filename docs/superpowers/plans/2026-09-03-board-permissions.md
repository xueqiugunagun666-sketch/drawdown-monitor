# 看板权限与全站登录 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给共享看板与日历加真实身份与操作权限 —— 只有管理员能删任何记录，普通用户只能删改自己添加的；停用/冻结/改报警档位收归管理员；所有破坏性操作写审计日志。

**Architecture:** 复用钱包区已有的 `users` + `sessions` 账号系统，中间件把账号闸门从 `/wallet` 扩到全站（共享口令保留做门禁，第二步再拆）。权限判定抽成 `src/lib/permissions.ts` 里的纯函数，路由只负责取身份、调判定、返回 401/403。归属存在 `tokens.owner_id` / `events.owner_id`。审计日志与主操作同事务。

**Tech Stack:** Next.js 15 (App Router)、better-sqlite3 + Drizzle、node:test、TypeScript（`.ts` 后缀 import）

> **⚠ 事务有两套 API，别混。** 本仓库两种都在用：
>
> | 拿到 db 的方式 | `.transaction(fn)` 的语义 | 正确写法 |
> |---|---|---|
> | `getDb()`（drizzle） | **立即执行**，返回 fn 的返回值，结果**不可调用** | `db.transaction(() => { … });` |
> | `getRawDb()`（better-sqlite3 原生） | 返回一个**可调用包装器**，不自动执行 | `const tx = db.transaction(() => { … }); tx();` |
>
> 在 drizzle 上多写一对括号（`db.transaction(fn)()`）会 `TypeError: ... is not a function`，
> 而且是**在事务提交之后**才抛 —— 删除已经生效了，接口却返回 500，用户以为没删掉。
> 本计划里所有审计相关的事务都用 `getDb()`，一律不加尾括号。

**Spec:** `docs/superpowers/specs/2026-09-02-board-permissions-design.md`

---

## 文件结构

**新增**

| 文件 | 职责 |
|---|---|
| `src/lib/permissions.ts` | 纯判定函数。不碰数据库、不碰 Request，只回答「这个人能不能做这件事」 |
| `src/lib/permissions.test.ts` | 权限矩阵的穷举测试 |
| `src/lib/adminAuth.ts` | `isAdmin(account)`，读 `ADMIN_ACCOUNT` |
| `src/lib/adminAuth.test.ts` | 含 fail-closed 用例 |
| `src/lib/accountAuthServer.ts` | 服务端组件用的取用户方式（`next/headers`），与纯净的 `accountAuth.ts` 分开 |
| `src/db/auditLog.ts` | 审计记录的写与读 |
| `src/db/auditLog.test.ts` | 含事务回滚用例 |
| `scripts/backfill-owner.ts` | 一次性回填历史归属 |
| `scripts/audit.ts` | `npm run audit` |
| `src/app/api/tokens/route.test.ts` | POST 归属与护栏 |
| `src/app/api/tokens/[id]/route.test.ts` | DELETE / PATCH 权限 |
| `src/app/api/events/[id]/route.test.ts` | 日历同构 |

**修改**：`src/db/schema.ts`、`src/db/migrate.ts`、`src/db/repo.ts`、`src/lib/config.ts`、`src/middleware.ts`、`src/app/api/tokens/route.ts`、`src/app/api/tokens/[id]/route.ts`、`src/app/api/events/route.ts`、`src/app/api/events/[id]/route.ts`、`src/app/api/rules/route.ts`、`src/components/TokenActions.tsx`、`src/components/Nav.tsx`、`src/components/UserBadge.tsx`、`src/app/page.tsx`、`package.json`、`.env.example`、`deploy/README.md`

**删除**：`src/app/api/user/route.ts`、`src/lib/user.ts`、`src/lib/user.test.ts`

**为什么把判定抽成纯函数**：路由里混着取 cookie、查库、判权限、写审计，四件事缠在一起就没法单测。`permissions.ts` 不依赖任何 IO，权限矩阵可以穷举验证；路由退化成「取身份 → 调判定 → 执行」，出错面小得多。

---

## Phase A —— 地基（不改变任何现有行为）

### Task 1: 修测试 glob，否则后面写的测试根本不会跑

**Files:**
- Modify: `package.json`

`npm test` 目前的 glob 不包含 `src/app/api/`，本计划新增的路由测试会被静默跳过。这个坑在这个项目里已经踩过一次（`src/db/` 曾经整个目录没跑）。必须第一个修。

- [ ] **Step 1: 先证明问题存在**

```bash
cd /Users/pananiu/projects/drawdown-monitor
mkdir -p src/app/api/tokens
cat > src/app/api/tokens/glob-probe.test.ts <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('这条必须失败，用来证明 glob 覆盖了本目录', () => {
  assert.equal(1, 2, 'glob 生效了');
});
EOF
npm test 2>&1 | tail -5
```

Expected: 测试全绿（404 pass / 0 fail）—— 说明那条注定失败的测试**根本没被执行**，问题确认。

- [ ] **Step 2: 改 glob**

`package.json` 的 `scripts.test` 改成：

```json
"test": "tsx --test src/lib/*.test.ts src/db/*.test.ts src/sources/*.test.ts src/worker/*.test.ts src/app/wallet/*.test.ts src/app/wallet/login/*.test.ts 'src/app/api/**/*.test.ts'"
```

- [ ] **Step 3: 验证 glob 现在生效**

```bash
npm test 2>&1 | tail -8
```

Expected: 出现 1 个 fail，信息是 `glob 生效了`。

- [ ] **Step 4: 删掉探针**

```bash
rm src/app/api/tokens/glob-probe.test.ts
npm test 2>&1 | tail -5
```

Expected: 404 pass / 0 fail。

- [ ] **Step 5: 提交**

```bash
git add package.json
git commit -m "test: 测试 glob 补上 src/app/api —— 该目录此前零覆盖"
```

---

### Task 2: 权限判定纯函数

**Files:**
- Create: `src/lib/permissions.ts`
- Test: `src/lib/permissions.test.ts`

- [ ] **Step 1: 写测试**

```ts
// src/lib/permissions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDelete, canEditMeta, canToggleGlobal, type Actor } from './permissions.ts';

const admin: Actor = { id: 'u-admin', name: 'pananiu', isAdmin: true };
const alice: Actor = { id: 'u-alice', name: 'alice', isAdmin: false };
const bob: Actor   = { id: 'u-bob',   name: 'bob',   isAdmin: false };

test('管理员能删任何东西，包括无主的', () => {
  assert.equal(canDelete(admin, 'u-alice'), true);
  assert.equal(canDelete(admin, null), true);
});

test('普通用户只能删自己的', () => {
  assert.equal(canDelete(alice, 'u-alice'), true);
  assert.equal(canDelete(alice, 'u-bob'), false);
});

test('无主的东西普通用户删不了 —— NULL 不等于任何人', () => {
  // 15 个历史代币里就有 1 个无主，这条不是假想情况
  assert.equal(canDelete(alice, null), false);
  assert.equal(canDelete(bob, null), false);
});

test('未登录一律不能删', () => {
  assert.equal(canDelete(null, 'u-alice'), false);
  assert.equal(canDelete(null, null), false);
});

test('改备注与删除同规则', () => {
  assert.equal(canEditMeta(admin, null), true);
  assert.equal(canEditMeta(alice, 'u-alice'), true);
  assert.equal(canEditMeta(alice, 'u-bob'), false);
  assert.equal(canEditMeta(null, 'u-alice'), false);
});

test('停用/冻结/改档位只有管理员', () => {
  assert.equal(canToggleGlobal(admin), true);
  assert.equal(canToggleGlobal(alice), false);
  assert.equal(canToggleGlobal(null), false);
});

test('空 owner id 当作无主，不能靠空字符串绕过', () => {
  // 万一哪天写入了空串，不能让它和「未设置 id」意外相等
  assert.equal(canDelete(alice, ''), false);
  assert.equal(canEditMeta(alice, ''), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/lib/permissions.test.ts`
Expected: FAIL，`Cannot find module './permissions.ts'`

- [ ] **Step 3: 实现**

```ts
// src/lib/permissions.ts
/**
 * 权限判定 —— 纯函数，不碰数据库也不碰 Request。
 *
 * 抽出来是为了能穷举测试。混在路由里的话，「管理员能不能删无主的」
 * 这种问题就得起一个 HTTP 请求才能验证，实际上没人会去验。
 *
 * 三条规则对应三个函数，不要合成一个带 action 参数的万能函数 ——
 * 那样调用点看不出在判什么，加一个动作就要改所有分支。
 */
export interface Actor {
  id: string;
  name: string;
  isAdmin: boolean;
}

/** 归属为 null（或空串）= 无主，只有管理员能动 */
function owns(actor: Actor, ownerId: string | null | undefined): boolean {
  return !!ownerId && ownerId === actor.id;
}

/** 删除：管理员删任何，其他人只删自己加的 */
export function canDelete(actor: Actor | null, ownerId: string | null | undefined): boolean {
  if (!actor) return false;
  return actor.isAdmin || owns(actor, ownerId);
}

/** 改备注/标签：与删除同规则。备注记录的是添加者的判断，别人改掉就丢了上下文 */
export function canEditMeta(actor: Actor | null, ownerId: string | null | undefined): boolean {
  if (!actor) return false;
  return actor.isAdmin || owns(actor, ownerId);
}

/** 停用/冻结/改报警档位：全局生效，只有管理员 */
export function canToggleGlobal(actor: Actor | null): boolean {
  return !!actor?.isAdmin;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/lib/permissions.test.ts`
Expected: 7 pass / 0 fail

- [ ] **Step 5: 提交**

```bash
git add src/lib/permissions.ts src/lib/permissions.test.ts
git commit -m "feat: 权限判定纯函数，可穷举测试"
```

---

### Task 3: 管理员判定与配置

**Files:**
- Create: `src/lib/adminAuth.ts`, `src/lib/adminAuth.test.ts`
- Modify: `src/lib/config.ts:39-49`（`Secrets` 接口与 `getSecrets`）

- [ ] **Step 1: 写测试**

```ts
// src/lib/adminAuth.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminName } from './adminAuth.ts';

// isAdminName 直接收配置值，避免测试依赖 process.env 与模块级缓存
test('配置为空时没有人是管理员 —— fail closed', () => {
  assert.equal(isAdminName('pananiu', undefined), false);
  assert.equal(isAdminName('pananiu', ''), false);
  assert.equal(isAdminName('pananiu', '   '), false);
});

test('名字匹配才是管理员', () => {
  assert.equal(isAdminName('pananiu', 'pananiu'), true);
  assert.equal(isAdminName('alice', 'pananiu'), false);
});

test('两侧都去空白 —— .env 里手抖多打个空格不该让管理员失效', () => {
  assert.equal(isAdminName('pananiu', ' pananiu '), true);
  assert.equal(isAdminName(' pananiu ', 'pananiu'), true);
});

test('区分大小写 —— users.name 是唯一键，PANANIU 是另一个账号', () => {
  assert.equal(isAdminName('PANANIU', 'pananiu'), false);
});

test('账号名为空不能匹配上空配置', () => {
  assert.equal(isAdminName('', ''), false);
  assert.equal(isAdminName('', 'pananiu'), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/lib/adminAuth.test.ts`
Expected: FAIL，`Cannot find module './adminAuth.ts'`

- [ ] **Step 3: 实现**

```ts
// src/lib/adminAuth.ts
/**
 * 管理员判定。
 *
 * 用账号名而不是 id：users.name 有 unique 约束，是稳定键；
 * id 是 uuid，写进 .env 没法人工核对对不对。
 *
 * **未配置时没有人是管理员**（fail closed）。反过来默认人人可删的话，
 * 配置一丢就等于把删除权限敞开给所有人 —— 那正是这次要消除的状态。
 */
import { getSecrets } from './config.ts';
import type { Account } from './accountAuth.ts';

/** 纯判定，配置值由调用方传入 —— 这样测试不用摆弄 process.env */
export function isAdminName(name: string, configured: string | undefined): boolean {
  const want = (configured ?? '').trim();
  const got = (name ?? '').trim();
  if (!want || !got) return false;
  return want === got;
}

export function isAdmin(account: Account | null): boolean {
  if (!account) return false;
  return isAdminName(account.name, getSecrets().adminAccount);
}
```

- [ ] **Step 4: 把 `adminAccount` 加进配置**

`src/lib/config.ts` 的 `Secrets` 接口末尾加一行：

```ts
  evmRpcBase: string | undefined;
  adminAccount: string | undefined;
```

`getSecrets()` 的对象字面量里加：

```ts
    evmRpcBase: process.env.EVM_RPC_BASE || undefined,
    adminAccount: process.env.ADMIN_ACCOUNT || undefined,
```

**不要**对 `adminAccount` 调 `registerSecret()` —— 它是账号名不是密钥，注册进掩码表会把日志里所有出现该用户名的地方都变成星号，排查问题时反而看不懂。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test src/lib/adminAuth.test.ts && npx tsc --noEmit`
Expected: 5 pass / 0 fail，tsc 无输出

- [ ] **Step 6: 提交**

```bash
git add src/lib/adminAuth.ts src/lib/adminAuth.test.ts src/lib/config.ts
git commit -m "feat: 管理员判定，未配置时 fail closed"
```

---

### Task 4: 数据库加列与审计表

**Files:**
- Modify: `src/db/schema.ts`, `src/db/migrate.ts`

- [ ] **Step 1: schema 加 ownerId**

`src/db/schema.ts` 的 `tokens` 表定义里，`visibility` 那行之后加：

```ts
  /** 添加者的 users.id。NULL = 无主（账号系统上线前加的），只有管理员能动 */
  ownerId: text('owner_id'),
```

`events` 表定义里 `createdBy` 那行之后加：

```ts
  ownerId: text('owner_id'),
```

- [ ] **Step 2: schema 加 audit_log 表**

`src/db/schema.ts` 末尾追加：

```ts
/**
 * 审计日志。
 *
 * actor_name 与 target_label 存**快照**而不是 JOIN 出来：账号会改名，
 * 代币删掉之后光看 id 根本不知道是什么。审计日志必须能脱离其他表
 * 独立读懂 —— 否则它记录的历史会被后来的变更改写。
 */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  atTs: integer('at_ts').notNull(),
  actorId: text('actor_id'),
  actorName: text('actor_name').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  targetLabel: text('target_label'),
  detail: text('detail'),
});
```

- [ ] **Step 3: migrate 补列与建表**

`src/db/migrate.ts` 的 `ADDED_COLUMNS` 数组末尾加：

```ts
  ['tokens', 'owner_id', 'TEXT'],
  ['events', 'owner_id', 'TEXT'],
```

同文件的 `DDL` 常量里追加建表语句（照抄现有其他表的写法）：

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ts INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at_ts DESC);
```

**不加外键**：`ALTER TABLE ADD COLUMN` 只作用于已存在的库，而全新安装走 `CREATE TABLE`。两边外键声明不一致会造成 schema 分叉，只在特定环境暴露。而且应用里根本没有删账号的路径，`ON DELETE SET NULL` 永远不会触发。

- [ ] **Step 4: 验证迁移幂等**

```bash
cd /Users/pananiu/projects/drawdown-monitor
cp data/monitor.db /tmp/mig-test.db
BEFORE=$(sqlite3 /tmp/mig-test.db 'SELECT COUNT(*) FROM tokens;')
DATABASE_PATH=/tmp/mig-test.db BEFORE="$BEFORE" npx tsx -e "
import { runMigrations } from './src/db/migrate.ts';
import { getRawDb } from './src/db/index.ts';
runMigrations(); runMigrations();          // 跑两次验幂等
const db = getRawDb();
const t = db.prepare('PRAGMA table_info(tokens)').all().map(c => c.name);
const e = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
const a = db.prepare('PRAGMA table_info(audit_log)').all().map(c => c.name);
const after = db.prepare('SELECT COUNT(*) c FROM tokens').get().c;
console.log('tokens.owner_id:', t.includes('owner_id'));
console.log('events.owner_id:', e.includes('owner_id'));
console.log('audit_log 列:', a.join(','));
console.log('迁移前后代币数一致:', String(after) === process.env.BEFORE, \`(\${process.env.BEFORE} -> \${after})\`);
"
rm -f /tmp/mig-test.db*
```

Expected:
```
tokens.owner_id: true
events.owner_id: true
audit_log 列: id,at_ts,actor_id,actor_name,action,target_type,target_id,target_label,detail
迁移前后代币数一致: true (N -> N)
```

**不要写死行数**：本地库与生产库的代币数不同（写这份计划时本地 3、生产 15），而且看板一直在变。要验的不变量是「迁移没弄丢数据」，也就是前后相等 —— 写死数字只会在换环境时产生假警报。

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm test && npx tsc --noEmit`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/db/schema.ts src/db/migrate.ts
git commit -m "feat: tokens/events 加 owner_id，新增 audit_log 表"
```

---

### Task 5: 审计日志的写与读

**Files:**
- Create: `src/db/auditLog.ts`, `src/db/auditLog.test.ts`

- [ ] **Step 1: 写测试**

```ts
// src/db/auditLog.test.ts
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
  assert.equal(rows[0].targetId, 'second', '最新的应该在最前面');
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test src/db/auditLog.test.ts`
Expected: FAIL，`Cannot find module './auditLog.ts'`

- [ ] **Step 3: 实现**

```ts
// src/db/auditLog.ts
/**
 * 审计日志的写与读。
 *
 * `recordAudit` **不自己开事务** —— 它要能被包进调用方的事务里，
 * 这样「删除 + 记日志」才是原子的。日志写失败就让整个操作回滚：
 * best-effort 的审计在最需要它的时候恰好可能是空的。
 */
import { desc } from 'drizzle-orm';
import { getDb } from './index.ts';
import { auditLog } from './schema.ts';
import { nowSec } from '../lib/time.ts';

export type AuditAction =
  | 'delete_token' | 'delete_event'
  | 'update_note'
  | 'set_enabled' | 'set_frozen'
  | 'update_rules';

export interface AuditInput {
  actorId: string | null;
  actorName: string;
  action: AuditAction;
  targetType: 'token' | 'event' | 'rules';
  targetId: string | null;
  targetLabel: string | null;
  /** 主要存旧值 —— 改备注时不存旧内容的话，原文就永久丢了 */
  detail?: unknown;
}

export function recordAudit(input: AuditInput): void {
  getDb().insert(auditLog).values({
    atTs: nowSec(),
    actorId: input.actorId,
    actorName: input.actorName,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    targetLabel: input.targetLabel,
    detail: input.detail === undefined ? null : JSON.stringify(input.detail),
  }).run();
}

export function listAudit(limit = 50) {
  return getDb().select().from(auditLog).orderBy(desc(auditLog.atTs), desc(auditLog.id)).limit(limit).all();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test src/db/auditLog.test.ts`
Expected: 4 pass / 0 fail

- [ ] **Step 5: 提交**

```bash
git add src/db/auditLog.ts src/db/auditLog.test.ts
git commit -m "feat: 审计日志，与主操作同事务"
```

---

## Phase B —— 后端执行点

### Task 6: repo 支持归属与带审计的删除

**Files:**
- Modify: `src/db/repo.ts:31-55`（`addToken` / `deleteToken`）、`src/db/repo.ts:513-521`（`upsertEvent` / `deleteEvent`）

- [ ] **Step 1: addToken 接受 ownerId**

`src/db/repo.ts` 的 `addToken` 改成：

```ts
export function addToken(input: {
  chain: string; address: string; note: string; tags?: string[];
  createdBy?: string | null; ownerId?: string | null;
}): TokenRow {
  const id = `${input.chain}:${input.address}`;
  const row = {
    id, chain: input.chain, address: input.address, symbol: null, name: null, decimals: null,
    addedAt: nowSec(), note: input.note, tags: JSON.stringify(input.tags ?? []),
    frozen: 0, enabled: 1, lastSource: null, lastQuoteAt: null, failCount: 0,
    createdBy: input.createdBy ?? null,
    ownerId: input.ownerId ?? null,
  };
  getDb().insert(tokens).values(row).onConflictDoNothing().run();
  return getToken(id)!;
}
```

- [ ] **Step 2: 删除包进事务并写审计**

`deleteToken` 改成接受审计信息，整体一个事务：

```ts
/**
 * 删除代币，连带清掉它的 K 线/池子/报警历史。
 *
 * 审计参数是必填的：删除不可逆，没有记录就等于没发生过 ——
 * PONZI 那次就是这样，只能靠比对备份才知道丢了什么。
 * 审计写失败时整个删除回滚（同一个事务）。
 */
export function deleteToken(id: string, audit: { actorId: string | null; actorName: string }): void {
  const db = getDb();
  const snapshot = getToken(id);
  db.transaction(() => {
    db.delete(backfillJobs).where(eq(backfillJobs.tokenId, id)).run();
    db.delete(alerts).where(eq(alerts.tokenId, id)).run();
    db.delete(alertStates).where(eq(alertStates.tokenId, id)).run();
    db.delete(athState).where(eq(athState.tokenId, id)).run();
    db.delete(candles).where(eq(candles.tokenId, id)).run();
    db.delete(pools).where(eq(pools.tokenId, id)).run();
    db.delete(tokens).where(eq(tokens.id, id)).run();
    recordAudit({
      actorId: audit.actorId, actorName: audit.actorName,
      action: 'delete_token', targetType: 'token',
      targetId: id, targetLabel: snapshot?.symbol ?? null,
      detail: snapshot ? { chain: snapshot.chain, address: snapshot.address,
        note: snapshot.note, createdBy: snapshot.createdBy, ownerId: snapshot.ownerId } : null,
    });
  });
}
```

文件顶部加 import：

```ts
import { recordAudit } from './auditLog.ts';
```

- [ ] **Step 3: deleteEvent 同样处理**

```ts
export function deleteEvent(id: string, audit: { actorId: string | null; actorName: string }): void {
  const db = getDb();
  const snapshot = getEvent(id);
  db.transaction(() => {
    db.delete(events).where(eq(events.id, id)).run();
    recordAudit({
      actorId: audit.actorId, actorName: audit.actorName,
      action: 'delete_event', targetType: 'event',
      targetId: id, targetLabel: snapshot?.title ?? null,
      detail: snapshot ? { atTs: snapshot.atTs, note: snapshot.note,
        createdBy: snapshot.createdBy, ownerId: snapshot.ownerId } : null,
    });
  });
}
```

- [ ] **Step 4: 修补所有调用点**

```bash
grep -rn "deleteToken(\|deleteEvent(" src scripts --include='*.ts' --include='*.tsx' | grep -v "export function"
```

每个调用点都要补审计参数。脚本类调用（如 `scripts/repair-token.ts`）传 `{ actorId: null, actorName: 'cli' }`。

- [ ] **Step 5: 类型检查与全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: tsc 无输出；测试全绿。若有测试因 `deleteToken` 签名变化而失败，补上审计参数。

- [ ] **Step 6: 提交**

```bash
git add src/db/repo.ts
git commit -m "feat: 删除写审计，与删除同事务；addToken 接受 ownerId"
```

---

### Task 7: 服务端组件取当前用户

**Files:**
- Create: `src/lib/accountAuthServer.ts`

现有 `accountAuth.currentUser(req)` 要一个 `Request`，服务端组件里没有。不要把 `next/headers` 塞进 `accountAuth.ts` —— 那会让它在测试与 worker 里都不能 import。

- [ ] **Step 1: 实现**

```ts
// src/lib/accountAuthServer.ts
/**
 * 服务端组件取当前账号。
 *
 * 单独一个文件而不是塞进 accountAuth.ts：`next/headers` 只能在
 * Next 的服务端上下文里 import，混进去会让 accountAuth.ts 在
 * node:test 与 worker 进程里直接崩掉。
 */
import { cookies } from 'next/headers';
import { SESSION_COOKIE, hashToken } from './session.ts';
import { findUserBySessionHash } from '../db/walletRepo.ts';
import { isAdmin } from './adminAuth.ts';
import type { Actor } from './permissions.ts';

export async function currentActor(): Promise<Actor | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const account = findUserBySessionHash(hashToken(raw), Math.floor(Date.now() / 1000));
  if (!account) return null;
  return { id: account.id, name: account.name, isAdmin: isAdmin(account) };
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add src/lib/accountAuthServer.ts
git commit -m "feat: 服务端组件取当前账号，与纯净的 accountAuth 分开"
```

---

### Task 8: 代币 API 加权限

**Files:**
- Modify: `src/app/api/tokens/route.ts`, `src/app/api/tokens/[id]/route.ts`
- Test: `src/app/api/tokens/[id]/route.test.ts`

- [ ] **Step 1: 写测试**

```ts
// src/app/api/tokens/[id]/route.test.ts
/**
 * 直接打路由函数，不经过 HTTP —— 权限是后端边界，
 * 前端隐藏按钮不算数，必须在这一层验证。
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_ACCOUNT = 'boss';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../../../db/migrate.ts';
import * as repo from '../../../../db/repo.ts';
import * as wr from '../../../../db/walletRepo.ts';
import { hashToken } from '../../../../lib/session.ts';
import { DELETE, PATCH } from './route.ts';

let boss: { id: string }, alice: { id: string }, bobTok: string, aliceTok: string, bossTok: string;

before(() => {
  runMigrations();
  boss = wr.createUser('boss', 'h')!;
  alice = wr.createUser('alice', 'h')!;
  const bob = wr.createUser('bob', 'h')!;
  bossTok = 'tok-boss'; aliceTok = 'tok-alice'; bobTok = 'tok-bob';
  wr.createSession(boss.id, hashToken(bossTok), 9e9);
  wr.createSession(alice.id, hashToken(aliceTok), 9e9);
  wr.createSession(bob.id, hashToken(bobTok), 9e9);
});

const req = (token: string | null, body?: unknown) => new Request('http://x/', {
  method: 'POST',
  headers: token ? { cookie: `wallet_session=${token}`, 'content-type': 'application/json' } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id: encodeURIComponent(id) }) });

let n = 0;
const mkToken = (ownerId: string | null) => {
  const addr = `0x${(++n).toString().padStart(40, '0')}`;
  repo.addToken({ chain: 'bsc', address: addr, note: '原备注', ownerId });
  return `bsc:${addr}`;
};

test('未登录删除返回 401', async () => {
  const id = mkToken(alice.id);
  assert.equal((await DELETE(req(null), ctx(id))).status, 401);
});

test('普通用户删别人的返回 403，且代币还在', async () => {
  const id = mkToken(alice.id);
  assert.equal((await DELETE(req(bobTok), ctx(id))).status, 403);
  assert.ok(repo.getToken(id), '403 之后代币必须还在');
});

test('普通用户删无主的返回 403 —— NULL 不属于任何人', async () => {
  const id = mkToken(null);
  assert.equal((await DELETE(req(aliceTok), ctx(id))).status, 403);
});

test('本人删自己的成功', async () => {
  const id = mkToken(alice.id);
  assert.equal((await DELETE(req(aliceTok), ctx(id))).status, 200);
  assert.equal(repo.getToken(id), undefined);
});

test('管理员删无主的成功', async () => {
  const id = mkToken(null);
  assert.equal((await DELETE(req(bossTok), ctx(id))).status, 200);
});

test('普通用户改别人的备注 403', async () => {
  const id = mkToken(alice.id);
  assert.equal((await PATCH(req(bobTok, { note: '篡改' }), ctx(id))).status, 403);
  assert.equal(repo.getToken(id)!.note, '原备注');
});

test('普通用户改 enabled 403，管理员可以', async () => {
  const id = mkToken(alice.id);
  assert.equal((await PATCH(req(aliceTok, { enabled: false }), ctx(id))).status, 403);
  assert.equal(repo.getToken(id)!.enabled, 1, '403 之后不能生效');
  assert.equal((await PATCH(req(bossTok, { enabled: false }), ctx(id))).status, 200);
});

test('置顶任何登录用户都能改，包括别人的和无主的', async () => {
  const a = mkToken(alice.id);
  assert.equal((await PATCH(req(bobTok, { pinned: true }), ctx(a))).status, 200);
  const b = mkToken(null);
  assert.equal((await PATCH(req(bobTok, { pinned: true }), ctx(b))).status, 200);
});

test('原子性：note + enabled 一起提交且无权改 enabled，note 也不能落库', async () => {
  const id = mkToken(alice.id);
  const res = await PATCH(req(aliceTok, { note: '新备注', enabled: false }), ctx(id));
  assert.equal(res.status, 403);
  assert.equal(repo.getToken(id)!.note, '原备注', '部分成功会让人以为整体成功了');
});

test('原子性：pinned + note 改别人的，pinned 也不能落库', async () => {
  const id = mkToken(alice.id);
  const res = await PATCH(req(bobTok, { pinned: true, note: '篡改' }), ctx(id));
  assert.equal(res.status, 403);
  assert.equal(repo.getToken(id)!.pinned, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test 'src/app/api/tokens/**/*.test.ts'`
Expected: FAIL（当前路由没有权限判定，多条断言不通过）

- [ ] **Step 3: 改写 `src/app/api/tokens/[id]/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { currentUser } from '../../../../lib/accountAuth.ts';
import { isAdmin } from '../../../../lib/adminAuth.ts';
import { canDelete, canEditMeta, canToggleGlobal, type Actor } from '../../../../lib/permissions.ts';
import { recordAudit } from '../../../../db/auditLog.ts';
import { notifyPlain } from '../../../../worker/notifier.ts';
import * as repo from '../../../../db/repo.ts';

export const dynamic = 'force-dynamic';

function actorOf(req: Request): Actor | null {
  const a = currentUser(req);
  return a ? { id: a.id, name: a.name, isAdmin: isAdmin(a) } : null;
}

const unauthorized = () => NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
const forbidden = (msg: string) => NextResponse.json({ error: msg }, { status: 403 });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = actorOf(req);
  if (!actor) return unauthorized();

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  const token = repo.getToken(tokenId);
  if (!token) return NextResponse.json({ error: '代币不存在' }, { status: 404 });

  let body: { note?: string; enabled?: boolean; frozen?: boolean; tags?: string[]; pinned?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }

  // 权限先全部判完再动手 —— 部分成功会让人以为整个请求成功了，
  // 回头发现只改了一半
  const touchesGlobal = body.enabled !== undefined || body.frozen !== undefined;
  const touchesMeta = body.note !== undefined || body.tags !== undefined;
  if (touchesGlobal && !canToggleGlobal(actor)) return forbidden('停用与冻结仅管理员可操作');
  if (touchesMeta && !canEditMeta(actor, token.ownerId)) {
    return forbidden('备注只有添加者本人或管理员能改');
  }

  const patch: Record<string, unknown> = {};
  if (body.note !== undefined) {
    const note = String(body.note).trim();
    if (!note) return NextResponse.json({ error: '备注不能为空 —— 报警时最需要回忆的就是当初为什么关注它' }, { status: 400 });
    patch.note = note;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
  if (body.frozen !== undefined) patch.frozen = body.frozen ? 1 : 0;
  if (body.pinned !== undefined) patch.pinned = body.pinned ? 1 : 0;
  if (body.tags !== undefined) patch.tags = JSON.stringify(body.tags);
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: '没有要修改的字段' }, { status: 400 });

  repo.updateTokenMetaAudited(tokenId, patch, {
    actorId: actor.id, actorName: actor.name,
    label: token.symbol ?? null, oldNote: token.note,
  });
  return NextResponse.json({ token: repo.getToken(tokenId) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = actorOf(req);
  if (!actor) return unauthorized();

  const { id } = await ctx.params;
  const tokenId = decodeURIComponent(id);
  const token = repo.getToken(tokenId);
  if (!token) return NextResponse.json({ error: '代币不存在' }, { status: 404 });

  if (!canDelete(actor, token.ownerId)) {
    return forbidden('只能删除自己添加的，或者找管理员');
  }

  repo.deleteToken(tokenId, { actorId: actor.id, actorName: actor.name });

  // 推送在事务之外、尽力而为：网络调用绝不能放进数据库事务，
  // 推失败不该让已经完成的删除回滚
  void notifyPlain(`${actor.name} 删除了 ${token.symbol ?? tokenId}（${token.chain}）`);

  return NextResponse.json({ deleted: tokenId });
}
```

- [ ] **Step 4: 在 repo 里加 `updateTokenMetaAudited`**

`src/db/repo.ts` 的 `updateTokenMeta` 之后追加：

```ts
/**
 * 带审计的元数据更新。备注是覆盖式的，旧内容不记下来就永久丢了。
 * 停用/冻结全局生效且悄无声息，别人加的币被停了他不会知道 —— 也要记。
 */
export function updateTokenMetaAudited(
  id: string,
  patch: Record<string, unknown>,
  audit: { actorId: string | null; actorName: string; label: string | null; oldNote: string | null },
): void {
  const db = getDb();
  db.transaction(() => {
    db.update(tokens).set(patch).where(eq(tokens.id, id)).run();
    if (patch.note !== undefined) {
      recordAudit({ actorId: audit.actorId, actorName: audit.actorName,
        action: 'update_note', targetType: 'token', targetId: id, targetLabel: audit.label,
        detail: { from: audit.oldNote, to: patch.note } });
    }
    if (patch.enabled !== undefined) {
      recordAudit({ actorId: audit.actorId, actorName: audit.actorName,
        action: 'set_enabled', targetType: 'token', targetId: id, targetLabel: audit.label,
        detail: { to: patch.enabled } });
    }
    if (patch.frozen !== undefined) {
      recordAudit({ actorId: audit.actorId, actorName: audit.actorName,
        action: 'set_frozen', targetType: 'token', targetId: id, targetLabel: audit.label,
        detail: { to: patch.frozen } });
    }
  });
}
```

- [ ] **Step 5: 改 `src/app/api/tokens/route.ts` 的 POST**

把 `readName(req)` 那段换成：

```ts
  const actor = actorOf(req);            // 与 [id]/route.ts 同样的取法
  if (!actor) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  // 归属只从会话取，**绝不接受请求体里的 ownerId/createdBy** ——
  // 一旦某个路由接受客户端传来的归属，权限就名存实亡：
  // 改个参数就能把币记到别人名下，或者记到自己名下再删掉
  const added = items.map((i) =>
    repo.addToken({
      chain: i.chain!, address: i.address!, note: i.note!.trim(),
      createdBy: actor.name, ownerId: actor.id,
    }),
  );
```

同时删掉 `import { readName } from '../../../lib/user.ts';`，并把 `actorOf` 抽到 `src/lib/permissions.ts` 之外的共用位置 —— 放在 `src/lib/accountAuthServer.ts` 里新增一个 `actorFromRequest(req)` 供两个路由 import，避免复制粘贴。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx tsx --test 'src/app/api/tokens/**/*.test.ts' && npx tsc --noEmit`
Expected: 10 pass / 0 fail

- [ ] **Step 7: 提交**

```bash
git add src/app/api/tokens src/db/repo.ts src/lib/accountAuthServer.ts
git commit -m "feat: 代币 API 加权限判定与审计，删除推 Telegram"
```

---

### Task 9: 日历 API 加权限

**Files:**
- Modify: `src/app/api/events/route.ts`, `src/app/api/events/[id]/route.ts`
- Test: `src/app/api/events/[id]/route.test.ts`

- [ ] **Step 1: 写测试**

结构与 Task 8 相同，覆盖：未登录 401、删别人的 403、删无主的 403、本人删自己的 200、管理员删任何 200、改别人的日程 403。日历没有 enabled/frozen，所有字段同一规则。

```ts
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_ACCOUNT = 'boss';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../../../db/migrate.ts';
import * as repo from '../../../../db/repo.ts';
import * as wr from '../../../../db/walletRepo.ts';
import { hashToken } from '../../../../lib/session.ts';
import { DELETE, PATCH } from './route.ts';

let boss: { id: string }, alice: { id: string };
let bossTok = 'e-boss', aliceTok = 'e-alice', bobTok = 'e-bob';

before(() => {
  runMigrations();
  boss = wr.createUser('boss', 'h')!;
  alice = wr.createUser('alice', 'h')!;
  const bob = wr.createUser('bob', 'h')!;
  wr.createSession(boss.id, hashToken(bossTok), 9e9);
  wr.createSession(alice.id, hashToken(aliceTok), 9e9);
  wr.createSession(bob.id, hashToken(bobTok), 9e9);
});

const req = (token: string | null, body?: unknown) => new Request('http://x/', {
  method: 'POST',
  headers: token ? { cookie: `wallet_session=${token}`, 'content-type': 'application/json' } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let n = 0;
const mkEvent = (ownerId: string | null) => {
  const id = `ev-${++n}`;
  repo.upsertEvent({ id, title: '原标题', atTs: 9e8, inputTz: 'Asia/Shanghai',
    priority: 'normal', remindOffsets: '[0]', createdAt: 1, ownerId });
  return id;
};

test('未登录删日程 401', async () => {
  assert.equal((await DELETE(req(null), ctx(mkEvent(alice.id)))).status, 401);
});

test('删别人的日程 403，日程还在', async () => {
  const id = mkEvent(alice.id);
  assert.equal((await DELETE(req(bobTok), ctx(id))).status, 403);
  assert.ok(repo.getEvent(id));
});

test('删无主日程 403', async () => {
  assert.equal((await DELETE(req(aliceTok), ctx(mkEvent(null)))).status, 403);
});

test('本人删自己的、管理员删无主的，都成功', async () => {
  const own = mkEvent(alice.id);
  assert.equal((await DELETE(req(aliceTok), ctx(own))).status, 200);
  const orphan = mkEvent(null);
  assert.equal((await DELETE(req(bossTok), ctx(orphan))).status, 200);
});

test('改别人的日程 403，标题不变', async () => {
  const id = mkEvent(alice.id);
  assert.equal((await PATCH(req(bobTok, { title: '篡改' }), ctx(id))).status, 403);
  assert.equal(repo.getEvent(id)!.title, '原标题');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test 'src/app/api/events/**/*.test.ts'`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/app/api/events/[id]/route.ts` 的 PATCH 与 DELETE 开头都加：

```ts
  const actor = actorFromRequest(req);
  if (!actor) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });

  const event = repo.getEvent(id);
  if (!event) return NextResponse.json({ error: '日程不存在' }, { status: 404 });

  // 日历没有 enabled/frozen，全部字段同一规则
  if (!canEditMeta(actor, event.ownerId)) {     // DELETE 用 canDelete
    return NextResponse.json({ error: '只能修改自己添加的，或者找管理员' }, { status: 403 });
  }
```

DELETE 里调 `repo.deleteEvent(id, { actorId: actor.id, actorName: actor.name })`。

`src/app/api/events/route.ts` 的 POST 把 `createdBy: readName(req)` 换成 `createdBy: actor.name, ownerId: actor.id`，并同样加登录检查。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test 'src/app/api/events/**/*.test.ts' && npx tsc --noEmit`
Expected: 5 pass / 0 fail

- [ ] **Step 5: 提交**

```bash
git add src/app/api/events
git commit -m "feat: 日历 API 加权限与审计，与看板同一套规则"
```

---

### Task 10: 报警档位收归管理员

**Files:**
- Modify: `src/app/api/rules/route.ts`

- [ ] **Step 1: 改 PUT**

在 `PUT` 的 `checkAuth` 之后加：

```ts
  const actor = actorFromRequest(req);
  if (!actor) return NextResponse.json({ error: '需要登录个人账号' }, { status: 401 });
  if (!canToggleGlobal(actor)) {
    return NextResponse.json({ error: '报警档位是全局设置，仅管理员可改' }, { status: 403 });
  }
```

写入成功后记一条审计：

```ts
  recordAudit({
    actorId: actor.id, actorName: actor.name, action: 'update_rules',
    targetType: 'rules', targetId: null, targetLabel: null, detail: body,
  });
```

`GET` 不动 —— 所有人都该能看到当前档位，否则报警来了不知道是按什么规则判的。

- [ ] **Step 2: 类型检查与全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: 全绿

- [ ] **Step 3: 提交**

```bash
git add src/app/api/rules/route.ts
git commit -m "feat: 报警档位收归管理员，读取不限制"
```

---

### Task 11: 中间件扩到全站

**Files:**
- Modify: `src/middleware.ts:22-23`

- [ ] **Step 1: 改前缀清单**

```ts
/**
 * 账号闸门覆盖全站（原本只管 /wallet）。
 *
 * 豁免的只有两类：共享口令入口，以及账号注册/登录入口本身 ——
 * 它们不能被账号闸门拦，否则会重定向到自己形成死循环。
 */
const WALLET_PREFIXES = ['/'];
const WALLET_PUBLIC = ['/login', '/api/login', '/wallet/login', '/api/account'];
```

`walletGate` 里 `needsAccount` 的判定改成「除豁免外全部需要」：

```ts
function walletGate(req: NextRequest, pathname: string) {
  if (WALLET_PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (req.cookies.get(WALLET_COOKIE)?.value) return NextResponse.next();
  // ... 原有的 401 / 重定向逻辑不变
}
```

**第二步的伏笔**：口令那一层（`middleware()` 里 `expected`/`siteOk` 的分支）一个字都不要动。第二步拆口令时应当只删这些行，不改 `walletGate`。

- [ ] **Step 2: 手工验证豁免路径**

```bash
npm run build && npm run start:prod &
sleep 8
for p in /login /wallet/login /api/account/login / /api/tokens; do
  printf '%-20s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000$p"
done
kill %1
```

Expected（本机无 `ACCESS_TOKEN` 时中间件整体放行，需临时设置环境变量验证）：`/login`、`/wallet/login`、`/api/account/login` 可达；`/` 与 `/api/tokens` 在无 `wallet_session` 时分别是 307 与 401。

- [ ] **Step 3: 提交**

```bash
git add src/middleware.ts
git commit -m "feat: 账号闸门从 /wallet 扩到全站"
```

---

## Phase C —— 前端

### Task 12: 按权限渲染操作按钮

**Files:**
- Modify: `src/components/TokenRow.tsx`, `src/components/TokenActions.tsx`, `src/app/page.tsx`

- [ ] **Step 1: page.tsx 传权限**

`src/app/page.tsx` 顶部加 import 与取用户：

```ts
import { currentActor } from '../lib/accountAuthServer.ts';
import { canDelete, canEditMeta, canToggleGlobal } from '../lib/permissions.ts';
```

在 `export default async function Home` 里：

```ts
  const actor = await currentActor();
```

`RowData` 组装处（`src/app/page.tsx:63` 附近）加三个字段：

```ts
      canDelete: canDelete(actor, t.ownerId),
      canEditMeta: canEditMeta(actor, t.ownerId),
      canToggleGlobal: canToggleGlobal(actor),
```

- [ ] **Step 2: RowData 接口加字段**

`src/components/TokenRow.tsx` 的 `RowData` 接口加：

```ts
  canDelete: boolean;
  canEditMeta: boolean;
  canToggleGlobal: boolean;
```

并把这三个传给 `<TokenActions … />`。

- [ ] **Step 3: TokenActions 按权限渲染**

`src/components/TokenActions.tsx` 的 `Props` 加三个布尔字段，返回的按钮行改成：

```tsx
  const nothing = !canEditMeta && !canToggleGlobal && !canDelete;
  if (nothing) {
    // 回填后 15 个代币里 12 个归 pananiu，所以对多数普通用户
    // 「一个按钮都没有」是常态而不是边缘情况。空着不说明理由会被当成界面坏了
    return (
      <div className="mt-1 text-xs text-neutral-700">只有添加者本人或管理员能修改</div>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex gap-2 text-xs text-neutral-600">
        {canEditMeta && <button onClick={() => setEditing(true)} className="hover:text-neutral-300">改备注</button>}
        {canToggleGlobal && (
          <button disabled={busy} onClick={() => void patch({ frozen: !frozen })}
            className="hover:text-neutral-300 disabled:opacity-40">{frozen ? '解冻' : '冻结'}</button>
        )}
        {canToggleGlobal && (
          <button disabled={busy} onClick={() => void patch({ enabled: !enabled })}
            className="hover:text-neutral-300 disabled:opacity-40">{enabled ? '停用' : '启用'}</button>
        )}
        {canDelete && (
          <button disabled={busy} onClick={remove} className="hover:text-red-400 disabled:opacity-40">删除</button>
        )}
      </div>
      {err && <div className="text-xs text-red-400 mt-1">{err}</div>}
    </div>
  );
```

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 均无错误

- [ ] **Step 5: 提交**

```bash
git add src/components/TokenRow.tsx src/components/TokenActions.tsx src/app/page.tsx
git commit -m "feat: 操作按钮按权限渲染，无权限时说明原因而不是留空"
```

---

### Task 13: 删掉署名机制

**Files:**
- Delete: `src/app/api/user/route.ts`, `src/lib/user.ts`, `src/lib/user.test.ts`
- Modify: `src/components/UserBadge.tsx`, `src/components/Nav.tsx`

- [ ] **Step 1: UserBadge 改为显示账号名**

```tsx
// src/components/UserBadge.tsx
/**
 * 当前账号。有了真身份之后，原来那个自填署名输入框就是纯冒充面，
 * 已经删掉 —— 名字现在由服务端从会话取，改不了。
 */
export default function UserBadge({ name, isAdmin }: { name: string | null; isAdmin: boolean }) {
  if (!name) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-500">
      {name}
      {isAdmin && (
        <span className="rounded px-1 py-0.5 text-[10px] bg-neutral-800 text-neutral-400">管理员</span>
      )}
    </span>
  );
}
```

不再是 `'use client'` —— 没有交互了。

- [ ] **Step 2: Nav 自己取账号**

`src/components/Nav.tsx` **已经是服务端组件**（文件顶部没有 `'use client'`），所以它可以直接取账号，不需要各个 `page.tsx` 逐个往下传。

把它改成 async，顶部加 import：

```ts
import { currentActor } from '../lib/accountAuthServer.ts';
```

函数签名改为 `export default async function Nav(...)`，函数体开头加：

```ts
  const actor = await currentActor();
```

第 33 行的 `<UserBadge />` 改成：

```tsx
          <UserBadge name={actor?.name ?? null} isAdmin={actor?.isAdmin ?? false} />
```

调用 `<Nav />` 的各个 page 都是服务端组件，async 组件可以直接渲染，调用点不用改。

- [ ] **Step 3: 删除署名模块**

```bash
git rm src/app/api/user/route.ts src/lib/user.ts src/lib/user.test.ts
grep -rn "lib/user.ts\|readName\|USER_COOKIE\|api/user" src --include='*.ts' --include='*.tsx'
```

Expected: 只剩 `src/lib/session.test.ts` 里那条用字面量 `'display_name'` 的护栏断言（保留）。

- [ ] **Step 4: 类型检查、测试、构建**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 全绿。测试总数会比之前少（`user.test.ts` 的用例被删）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor: 删掉自填署名 —— 有真账号之后它只是冒充面"
```

---

## Phase D —— 迁移与上线

### Task 14: 历史归属回填脚本

**Files:**
- Create: `scripts/backfill-owner.ts`
- Modify: `package.json`（加 `"backfill:owner"` 脚本）

- [ ] **Step 1: 实现**

```ts
/**
 * 一次性回填历史归属。
 *
 * 映射由用户本人确认，**不做任何字符串相似度匹配** ——
 * retend 与 retend666 形似纯属巧合，采信依据是用户确认。
 * 不在表里的署名（307大王小锐、赌命哥）保持无主，只有管理员能动。
 *
 * 幂等：只写 owner_id IS NULL 的行。
 * 按署名值匹配而非数量 —— 看板一直在变，写死数量会让脚本行为错误。
 */
import { runMigrations } from '../src/db/migrate.ts';
import { getRawDb } from '../src/db/index.ts';

const TOKEN_MAP: Array<[createdBy: string | null, accountName: string]> = [
  ['小牛', 'pananiu'],
  ['retend', 'retend666'],
  [null, 'pananiu'],          // 无署名的都是账号系统上线前加的，用户决定归管理员
];
const EVENT_MAP: Array<[createdBy: string | null, accountName: string]> = [
  ['小牛', 'pananiu'],
];

runMigrations();
const db = getRawDb();
const dry = process.argv.includes('--dry-run');

function userId(name: string): string {
  const r = db.prepare('SELECT id FROM users WHERE name = ?').get(name) as { id: string } | undefined;
  if (!r) throw new Error(`账号不存在: ${name} —— 回填中止，不猜`);
  return r.id;
}

for (const [table, map] of [['tokens', TOKEN_MAP], ['events', EVENT_MAP]] as const) {
  for (const [createdBy, account] of map) {
    const uid = userId(account);
    const where = createdBy === null
      ? `created_by IS NULL AND owner_id IS NULL`
      : `created_by = ? AND owner_id IS NULL`;
    const args = createdBy === null ? [uid] : [uid, createdBy];
    const count = db.prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE ${where}`,
    ).get(...(createdBy === null ? [] : [createdBy])) as { c: number };
    console.log(`${table}: 署名 ${createdBy ?? '<无>'} -> ${account}，${count.c} 行`);
    if (!dry) db.prepare(`UPDATE ${table} SET owner_id = ? WHERE ${where}`).run(...args);
  }
}

const orphanT = db.prepare('SELECT COUNT(*) c FROM tokens WHERE owner_id IS NULL').get() as { c: number };
const orphanE = db.prepare('SELECT COUNT(*) c FROM events WHERE owner_id IS NULL').get() as { c: number };
console.log(`\n剩余无主：代币 ${orphanT.c}、日程 ${orphanE.c}（只有管理员能删改）`);
if (dry) console.log('（--dry-run，未写入）');
```

`package.json` 加：

```json
"backfill:owner": "tsx --env-file-if-exists=.env scripts/backfill-owner.ts"
```

- [ ] **Step 2: 在生产库副本上先干跑**

```bash
scp drawdown:/opt/drawdown-monitor/data/monitor.db /tmp/prod-copy.db 2>/dev/null || \
  ssh drawdown 'sudo cp /opt/drawdown-monitor/data/monitor.db /tmp/c.db && sudo chown ubuntu /tmp/c.db' && \
  scp drawdown:/tmp/c.db /tmp/prod-copy.db
DATABASE_PATH=/tmp/prod-copy.db npm run backfill:owner -- --dry-run
```

Expected:
```
tokens: 署名 小牛 -> pananiu，4 行
tokens: 署名 retend -> retend666，2 行
tokens: 署名 <无> -> pananiu，8 行
events: 署名 小牛 -> pananiu，3 行

剩余无主：代币 15、日程 4（只有管理员能删改）
（--dry-run，未写入）
```

（干跑不写入，所以"剩余无主"仍是全量，这是预期的。）

- [ ] **Step 3: 在副本上真跑一次验证结果**

```bash
DATABASE_PATH=/tmp/prod-copy.db npm run backfill:owner
DATABASE_PATH=/tmp/prod-copy.db npm run backfill:owner    # 再跑一次验幂等
sqlite3 /tmp/prod-copy.db "SELECT COALESCE(u.name,'<无主>') owner, COUNT(*) FROM tokens t LEFT JOIN users u ON u.id=t.owner_id GROUP BY 1;"
rm -f /tmp/prod-copy.db
```

Expected: pananiu 12、retend666 2、`<无主>` 1；第二次执行输出的行数全是 0。

- [ ] **Step 4: 提交**

```bash
git add scripts/backfill-owner.ts package.json
git commit -m "feat: 历史归属回填脚本，按用户确认的映射写入"
```

---

### Task 15: 审计查看 CLI

**Files:**
- Create: `scripts/audit.ts`
- Modify: `package.json`

- [ ] **Step 1: 实现**

```ts
/** 查看审计日志。npm run audit -- 20 */
import { runMigrations } from '../src/db/migrate.ts';
import { listAudit } from '../src/db/auditLog.ts';

runMigrations();
const limit = Number(process.argv[2] ?? 30);
const rows = listAudit(limit);
if (rows.length === 0) { console.log('（没有记录）'); process.exit(0); }
for (const r of rows) {
  const t = new Date(r.atTs * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`${t}  ${r.actorName.padEnd(12)} ${r.action.padEnd(14)} ${r.targetLabel ?? r.targetId ?? ''}`);
  if (r.detail) console.log(`${' '.repeat(22)}${r.detail}`);
}
```

`package.json` 加：`"audit": "tsx --env-file-if-exists=.env scripts/audit.ts"`

- [ ] **Step 2: 验证**

```bash
DATABASE_PATH=/tmp/audit-test.db npx tsx -e "
import { runMigrations } from './src/db/migrate.ts';
import { recordAudit } from './src/db/auditLog.ts';
runMigrations();
recordAudit({ actorId:'u1', actorName:'pananiu', action:'delete_token',
  targetType:'token', targetId:'bsc:0x1', targetLabel:'PONZI', detail:{note:'旧'} });
"
DATABASE_PATH=/tmp/audit-test.db npm run audit
rm -f /tmp/audit-test.db*
```

Expected: 打印一行含 `pananiu`、`delete_token`、`PONZI`。

- [ ] **Step 3: 提交**

```bash
git add scripts/audit.ts package.json
git commit -m "feat: npm run audit 查看审计日志"
```

---

### Task 16: 配置与文档

**Files:**
- Modify: `.env.example`, `deploy/README.md`

- [ ] **Step 1: `.env.example` 加一行**

```
# 管理员账号名（对应 users.name）。不设 = 没有人是管理员，所有删除都会被拒
ADMIN_ACCOUNT=
```

- [ ] **Step 2: `deploy/README.md` 的「日常操作」后加一节**

```markdown
## 权限

删除、改备注、停用/冻结、改报警档位需要**管理员**。管理员由 `.env` 里的
`ADMIN_ACCOUNT` 指定，值是账号名（不是 uuid）：

```
ADMIN_ACCOUNT=pananiu
```

**不设或设错 = 没有人是管理员**，所有删除都会被拒（fail closed）。改完要重启：

```bash
systemctl restart drawdown-web
```

查看谁删过什么：

```bash
cd /opt/drawdown-monitor && sudo -u drawdown npm run audit
```
```

- [ ] **Step 3: 提交**

```bash
git add .env.example deploy/README.md
git commit -m "docs: 说明 ADMIN_ACCOUNT 与审计查看方式"
```

---

### Task 17: 全量验证与部署

- [ ] **Step 1: 本地全量检查**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: tsc 无输出、测试全绿、构建成功

- [ ] **Step 2: 部署前先在生产库副本上验一次迁移**

```bash
ssh drawdown 'sudo systemctl start drawdown-backup && sleep 5 && ls -lht /opt/drawdown-monitor/backups | head -3'
```

Expected: 出现刚生成的备份

- [ ] **Step 3: 同步代码**

```bash
cd /Users/pananiu/projects/drawdown-monitor
rsync -avn --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude 'data' \
  --exclude 'backups' --exclude 'backups-remote' --exclude '.env' \
  --exclude 'tsconfig.tsbuildinfo' --exclude '.DS_Store' \
  ./ drawdown:deploy-stage/
```

先看干跑输出，确认只有预期文件变动，再去掉 `-n` 实跑。

- [ ] **Step 4: 在服务器设置 ADMIN_ACCOUNT**

```bash
ssh drawdown "grep -q '^ADMIN_ACCOUNT=' /opt/drawdown-monitor/.env || \
  echo 'ADMIN_ACCOUNT=pananiu' | sudo tee -a /opt/drawdown-monitor/.env >/dev/null; \
  sudo grep -c '^ADMIN_ACCOUNT=' /opt/drawdown-monitor/.env"
```

Expected: `1`

- [ ] **Step 5: 构建并重启（只重启 web，worker 不受影响）**

```bash
ssh drawdown 'sudo rsync -a --delete --exclude ".git" --exclude "node_modules" \
  --exclude ".next" --exclude "data" --exclude "backups" --exclude "backups-remote" \
  --exclude ".env" --exclude "tsconfig.tsbuildinfo" \
  ~/deploy-stage/ /opt/drawdown-monitor/ && \
  sudo chown -R drawdown:drawdown /opt/drawdown-monitor/src /opt/drawdown-monitor/scripts && \
  cd /opt/drawdown-monitor && sudo -u drawdown npm run build 2>&1 | tail -5'
```

**注意**：worker 也 import 了 `repo.ts`（`deleteToken` 签名变了），所以这次 **worker 也要重启**，与上次的 UI 改动不同。

```bash
ssh drawdown 'sudo systemctl restart drawdown-web drawdown-worker'
```

- [ ] **Step 6: 跑回填**

```bash
ssh drawdown 'cd /opt/drawdown-monitor && sudo -u drawdown npm run backfill:owner -- --dry-run'
```

确认行数符合预期后去掉 `--dry-run` 实跑。

- [ ] **Step 7: 线上验证**

```bash
ssh drawdown 'cd /opt/drawdown-monitor && sudo -u drawdown npm run audit'
ssh drawdown 'sudo sqlite3 /opt/drawdown-monitor/data/monitor.db \
  "SELECT COALESCE(u.name,\"<无主>\"), COUNT(*) FROM tokens t LEFT JOIN users u ON u.id=t.owner_id GROUP BY 1;"'
ssh drawdown 'systemctl is-active drawdown-web drawdown-worker caddy'
```

Expected: 归属分布为 pananiu 12 / retend666 2 / `<无主>` 1；三个服务都 active

- [ ] **Step 8: 用真实账号验一次权限**

在浏览器里用非管理员账号登录，确认：看得到看板、能添加、**看不到删除按钮**、无权限的行显示「只有添加者本人或管理员能修改」。再用 `pananiu` 登录确认按钮齐全。

- [ ] **Step 9: 提交部署记录**

```bash
git add -A && git commit -m "chore: 权限系统上线" || echo "无待提交内容"
```

---

## 自查

**规格覆盖**：管理员判定 → Task 3；归属列与审计表 → Task 4；审计写读 → Task 5；权限矩阵 → Task 2 + 8 + 9 + 10；中间件 → Task 11；前端 → Task 12 + 13；历史回填 → Task 14；审计 CLI → Task 15；配置文档 → Task 16；测试 glob → Task 1。

**已知的顺序依赖**：Task 1 必须最先（否则后面所有路由测试静默不跑）；Task 2、3 是 Task 8-10 的前置；Task 6 改了 `deleteToken` 签名，会连带影响 worker，部署时两个服务都要重启（Task 17 Step 5 已写明）。

**已核对的签名**（计划里的测试代码直接用了这些，写之前逐个查过实际实现）：

- `wr.createUser(name, passwordHash)` → `{ id, name } | null`
- `wr.createSession(userId, tokenHash, expiresAt)` → `void`
- `wr.findUserBySessionHash(tokenHash, now)` → `{ id, name } | null`
- `repo.upsertEvent(e: typeof events.$inferInsert)`，必填 `id / title / atTs / inputTz / remindOffsets / createdAt`
- `Nav.tsx` 是服务端组件（无 `'use client'`），可直接 async 取账号

**唯一没写死的地方**：Task 6 Step 4 要 grep 出 `deleteToken` / `deleteEvent` 的全部调用点再逐个补参数 —— 调用点数量取决于实施时的代码状态，所以给的是 grep 命令而不是清单。
