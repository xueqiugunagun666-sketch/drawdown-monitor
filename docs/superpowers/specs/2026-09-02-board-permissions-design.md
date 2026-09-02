# 看板权限与全站登录 设计文档

**日期：** 2026-09-02
**状态：** 已确认，待写实施计划
**范围：** 两步走的**第一步**。终态（取消共享口令、改注册邀请码）见「分两步走」，另立文档。

## 目标

给共享看板加真实身份与删除权限：任何登录用户都能添加代币，但**只有管理员能删除任何一个**，普通用户只能删自己加的。备注与标签同样收归添加者本人与管理员 —— 它记录的是「当初为什么关注它」，被别人改掉就丢了上下文。停用、冻结、改报警档位这三个全局生效的操作收归管理员。日历（events）适用同一套规则。

## 背景：现在为什么拦不住

`src/lib/user.ts` 的注释已经写明了这个局限：

> 用户名是自己填的、没有单独密码，理论上能冒充他人，也拦不住谁删别人的东西。要真身份就得上 users 表 + 密码哈希，那是另一件事。

现状是两套并行的鉴权：

| 层 | 机制 | 覆盖范围 |
|---|---|---|
| 全站口令 | cookie `access_token`，中间件与环境变量比对，**服务端无状态** | 除 `/login` 外的全部页面与 API |
| 个人账号 | `users` + `sessions` 表，scrypt 密码，会话存哈希，TTL 30 天 | 仅 `/wallet` 与 `/api/wallet` |

看板走的是第一层，所以「谁加的」只是 `tokens.created_by` 里的一段自填文本，`DELETE /api/tokens/[id]` 只校验共享口令 —— 拿到口令的任何人都能删任何东西。

### 生产现状（2026-09-02 实测）

- **账号 8 个**：pananiu（最早，08-30 22:49）、dadiaoxuan、retend666、an、an.、xx、649257499、梅仁艾
- **活跃会话 14 个**，8 个账号全都有，最晚过期 2026-10-02
- **看板代币 16 个**，全部 `visibility='public'`
- **署名分布**：9 个为空、`小牛` 4 个、`retend` 2 个、`307大王小锐` 1 个

关键事实：**署名与账号名是两个命名空间，对不上。** `小牛` 不对应任何账号，`retend` 与账号 `retend666` 也只是形似。因此历史数据的归属无法从署名推导。

## 已确认的决策

| 议题 | 决定 |
|---|---|
| 登录层次 | 保留共享口令做门禁，进来后再登个人账号（两层） |
| 管理员 | `pananiu` |
| 管理员标记方式 | 环境变量 `ADMIN_ACCOUNT` |
| 删除粒度 | 管理员删任何；普通用户删自己加的 |
| 额外收归管理员 | 停用（`enabled=0`）、冻结（`frozen=1`） |
| 改备注与标签 | 收归：管理员与添加者可改 |
| 置顶 | **不限制** —— 见「置顶为什么不收」 |
| 报警档位 `PUT /api/rules` | 收归管理员；读取不限制 |
| 日历 | 一起做，同一套规则 |
| 共享口令的归宿 | 最终取消，改为注册邀请码 —— **放第二步**，本文档不实施 |
| 没账号的人被挡在外面 | 可接受，需要注册 |

## 分两步走

最终形态是**只有账号系统，没有共享口令**。但分两步做，本文档只覆盖第一步。

### 第一步（本文档）

共享口令保留做门禁，在它之上加账号闸门与权限。跑几天确认 8 个人都能正常用。

万一权限判定有问题，共享口令还在当兜底 —— 至少不会变成「谁都进不来」或者「谁都能删」。

### 第二步（另立文档）

拆掉共享口令，`ACCESS_TOKEN` 转为**注册邀请码**：

- `/login` 页与 `/api/login` 下线，中间件去掉第一层
- 同一个秘密从「每次进门要输」变成「注册时输一次」，只在 `POST /api/account/register` 校验
- **登录本身不需要邀请码** —— 已有账号的人不受影响，8 个人一次都不用再输
- 密钥读取、掩码上报沿用现有那套，不新增机制

### 第一步不能把第二步堵死

现在两道闸门在代码里已经是分开的（`middleware.ts` 里 `middleware()` 管口令、`walletGate()` 管账号），第一步只扩展后者的覆盖范围，不把两者耦合。第二步删掉前者时应当只删不改。

**验收标准**：第二步的改动应当只涉及 `middleware.ts` 的口令分支、`/login` 相关文件的删除、以及注册路由加一处邀请码校验。如果第一步做完后发现第二步要动权限判定的代码，说明第一步耦合错了。

## 架构

### 身份来源

复用现有账号系统，不新建机制：

- `users`（id / name unique / password_hash / created_at）
- `sessions`（token_hash 主键 / user_id / expires_at），TTL 30 天
- `src/lib/accountAuth.ts` 的 `currentUser(req)` 与 `requireUser(req)`

### 管理员判定

新增环境变量：

```
ADMIN_ACCOUNT=pananiu
```

新增 `src/lib/adminAuth.ts`，只做一件事：

```ts
/**
 * 管理员判定。
 *
 * 用账号名而不是 id：users.name 有 unique 约束，是稳定键；
 * 而 id 是 uuid，写进 .env 没法人工核对。
 *
 * 未配置时 **没有人是管理员**（fail closed）。反过来默认人人可删的话，
 * 配置一丢就等于把删除权限敞开给所有人 —— 那正是这次要消除的状态。
 */
export function isAdmin(account: Account | null): boolean;
```

`ADMIN_ACCOUNT` 走 `src/lib/config.ts` 的 `getSecrets()`，与现有配置读取方式一致。上报配置时按项目惯例掩码输出。

### 归属

`tokens` 与 `events` 各新增一列：

```ts
ownerId: text('owner_id'),          // users.id，无主为 NULL
```

- 新增记录写入真实 `owner_id`
- `created_by` 保留用于展示，但**不再来自自填 cookie**，改为写入当前账号名

`src/db/migrate.ts` 的 `ADDED_COLUMNS` 会自动 ALTER，不需要停机：

```ts
['tokens', 'owner_id', 'TEXT'],
['events', 'owner_id', 'TEXT'],
```

**不加外键约束**，理由有两条：

1. 应用连接开着 `foreign_keys = ON`（`src/db/index.ts:29`），但 `ALTER TABLE ADD COLUMN` 只作用于已存在的库。全新安装走 Drizzle 的 `CREATE TABLE` DDL，如果那里声明了外键而 `ADDED_COLUMNS` 的 ddl 字符串里没有，生产库和全新库的 schema 就会分叉 —— 这种分叉只在某些环境下暴露，很难查。
2. `ON DELETE SET NULL` 只在账号被删时才有意义，而**应用里根本没有删账号的路径**（既无 UI 也无 API）。为一个不会发生的事件引入 schema 分叉风险不划算。

将来真要加删账号功能，再一并处理孤儿 `owner_id`（届时无主记录的行为已经定义好了：只有管理员能删）。

### 历史数据

署名与账号是两个命名空间，无法从字符串推导对应关系。**以下映射由用户本人提供**，不是猜的：

| 署名 | 账号 | 代币数 | 来源 |
|---|---|---|---|
| `小牛` | `pananiu` | 4 | 用户告知 |
| `retend` | `retend666` | 2 | 用户告知 |
| `307大王小锐` | 无对应账号 | 1 | 未确认，留 NULL |
| （空） | — | 9 | 本来就没署名，留 NULL |

一次性回填脚本 `scripts/backfill-token-owner.ts` 处理前两行共 6 个代币，**只按上表写入，不做任何字符串相似度匹配**。脚本幂等：只写 `owner_id IS NULL` 的行，重复执行不会覆盖后来的归属。

其余 10 个代币与全部既有日程的 `owner_id` 保持 NULL，效果是只有管理员能删改。

**为什么不猜剩下的**：`307大王小锐` 在 8 个账号里找不到对应，可能是没注册的人；9 个无署名的更是无从谈起。猜错的代价是把别人的东西记到某人名下，而这次改动的全部意义就是让归属可信。如果以后确认了，往上表加一行重跑脚本即可。

## 权限矩阵

| 操作 | 未登录 | 普通用户（自己的） | 普通用户（他人/无主） | 管理员 |
|---|---|---|---|---|
| 浏览看板 / 日历 | ✗ | ✓ | ✓ | ✓ |
| 添加代币 / 日程 | ✗ | ✓ | — | ✓ |
| 改备注 / 标签 | ✗ | ✓ | ✗ | ✓ |
| 置顶 | ✗ | ✓ | ✓ | ✓ |
| 停用 `enabled` | ✗ | ✗ | ✗ | ✓ |
| 冻结 `frozen` | ✗ | ✗ | ✗ | ✓ |
| 删除 | ✗ | ✓ | ✗ | ✓ |
| 看报警档位 | ✗ | ✓ | ✓ | ✓ |
| 改报警档位 | ✗ | ✗ | ✗ | ✓ |

## 执行点

**后端是唯一的安全边界。** 前端隐藏按钮只为避免「点了才被拒」的困惑，不构成防护。

### 中间件 `src/middleware.ts`

把现有的 `walletGate` 从 `/wallet` 前缀扩展到全站。豁免清单：

- `/login`、`/api/login` —— 共享口令入口（已有）
- `/wallet/login`、`/api/account/*` —— 账号注册与登录入口
- `_next/static`、`_next/image`、`favicon.ico` —— 静态资源（已有 matcher 排除）

中间件跑在 edge runtime **不能查数据库**，因此它只判断 `wallet_session` cookie 是否存在；会话是否真的有效由各路由的 `currentUser()` 判定。这是有意的两层，不是冗余：中间件挡掉未登录的浏览，路由做真正的鉴权。

### API 路由

| 路由 | 方法 | 新要求 |
|---|---|---|
| `/api/tokens` | POST | 要登录；写 `owner_id` 与 `created_by`（账号名） |
| `/api/tokens/[id]` | DELETE | 要登录；`isAdmin` 或 `owner_id === user.id`，否则 403 |
| `/api/tokens/[id]` | PATCH | 要登录；`enabled`/`frozen` 要 `isAdmin`；`note`/`tags` 要 `isAdmin` 或 owner；`pinned` 只要登录。**任一字段不通过则整个请求 403，一个字段都不写** |
| `/api/events` | POST | 要登录；写 `owner_id` 与 `created_by` |
| `/api/events/[id]` | DELETE | 同 tokens DELETE |
| `/api/events/[id]` | PATCH | 要登录；`isAdmin` 或 owner（日程没有 enabled/frozen 概念，全部字段同一规则） |
| `/api/rules` | PUT | 要 `isAdmin`，否则 403 |
| `/api/user` | GET/POST | **整个删除** —— 署名机制被账号取代 |

只读路由（`GET /api/tokens`、`/api/alerts`、`/api/tokens/[id]/candles`、`GET /api/events`、`GET /api/backfill`）维持现状：中间件已经要求登录，不再叠加检查。

**403 与 401 要分清**：未登录返回 401（前端跳登录页），已登录但权限不足返回 403 并说明原因（前端提示，不跳转）。混用会导致有权限问题时把人踢去重新登录，登完还是不行。

### `PUT /api/rules` 收归管理员

全局报警档位（80/85/90/95%），改一次影响所有人的报警行为，比停用/冻结更全局。要 `isAdmin`，否则 403。

`GET /api/rules` 不限制 —— 所有人都该能看到当前档位是什么，否则报警来了不知道是按什么规则判的。

### 置顶为什么不收

备注收归是因为它记录的是**添加者的判断**（「当初为什么关注它」），被别人改掉就丢了上下文，而且改了不留痕迹。

置顶不一样：它不承载任何人的判断，只是「这几个最近要盯着」的临时标记，本来就是给所有人看的协作信号。谁发现某个币值得注意都该能顶上去。误操作的代价也只是顺序变了，点一下就能撤销 —— 与备注被覆盖不可恢复不是一个量级。

代价是别人能取消你的置顶。这个代价可以接受；真出现互相取消的情况再收。

## 前端

- **`src/components/TokenActions.tsx`**：按权限渲染。非管理员且非 owner 时不显示「删除」「改备注」；非管理员不显示「冻结」「停用」。置顶按钮（`PinButton`）对所有登录用户保留。
  - 非 owner 看到的这一行可能一个按钮都不剩（16 个历史代币里有 10 个无主，对非管理员就是这种情况）。这时不要渲染出一条空的操作区 —— 留个「只有添加者或管理员能改」的灰字说明，否则用户会以为界面坏了。
- **`src/components/Nav.tsx`**：删掉自填署名输入框。有了真账号之后它纯粹是冒充面。
- **`src/components/UserBadge.tsx`**：改为显示当前账号名，管理员加一个标记。
- **`/wallet/login`**：现在承担全站登录，页面文案里「钱包」的措辞要改成通用说法。路由路径不变（改路径会让 8 个人的书签失效，不值得）。
- 权限信息由服务端组件传入（`page.tsx` 已是 server component，可直接调 `currentUser()`），不新增客户端请求。

## 受影响文件清单

已实测确认，署名机制的影响面只有这些：

**新增**
- `src/lib/adminAuth.ts` —— `isAdmin()`
- `src/lib/adminAuth.test.ts`
- `src/app/api/tokens/[id]/route.test.ts`、`src/app/api/events/[id]/route.test.ts` 等路由测试
- `scripts/backfill-token-owner.ts` —— 一次性回填 6 个已确认归属的代币（小牛→pananiu 4 个、retend→retend666 2 个），幂等，只写 `owner_id IS NULL` 的行

**修改**
- `src/db/schema.ts` —— tokens / events 加 `ownerId`
- `src/db/migrate.ts` —— `ADDED_COLUMNS` 加两行
- `src/db/repo.ts` —— `addToken` / `addEvent` 接受 ownerId；新增按 id 取 owner 的查询
- `src/lib/config.ts` —— `getSecrets()` 加 `adminAccount`
- `src/middleware.ts` —— 账号闸门扩到全站
- `src/app/api/tokens/route.ts`、`src/app/api/tokens/[id]/route.ts`
- `src/app/api/events/route.ts`、`src/app/api/events/[id]/route.ts`
- `src/components/TokenActions.tsx` —— 按权限渲染
- `src/components/Nav.tsx` —— 去掉署名输入框
- `src/components/UserBadge.tsx` —— 改为显示账号名，去掉 `/api/user` 请求
- `src/app/page.tsx`、`src/app/calendar/page.tsx` —— 服务端把权限信息传给客户端组件
- `package.json` —— 测试 glob 加 `src/app/api/**/*.test.ts`
- `.env.example` —— 加 `ADMIN_ACCOUNT`
- `deploy/README.md` —— 说明新环境变量

**删除**
- `src/app/api/user/route.ts` —— 署名读写接口
- `src/lib/user.ts`、`src/lib/user.test.ts` —— 整个署名模块

`src/lib/session.test.ts:32` 有一条 `assert.notEqual(SESSION_COOKIE, 'display_name')` 的护栏断言，用的是字面量而非导入，删除 `user.ts` 后仍然编译通过，保留即可。

## 错误处理

| 情况 | 行为 |
|---|---|
| 未登录访问页面 | 中间件 302 到 `/wallet/login` |
| 未登录访问 API | 401 + `{ error: '需要登录个人账号' }` |
| 已登录但删别人的 | 403 + `{ error: '只能删除自己添加的，或者找管理员' }` |
| 已登录但改 enabled/frozen | 403 + `{ error: '停用与冻结仅管理员可操作' }` |
| 已登录但改别人的备注/标签 | 403 + `{ error: '备注只有添加者本人或管理员能改' }` |
| 已登录但改报警档位 | 403 + `{ error: '报警档位是全局设置，仅管理员可改' }` |
| `ADMIN_ACCOUNT` 未配置 | 没有人是管理员；worker 启动时打 WARN，与现有 `ACCESS_TOKEN` 未配置的告警一致 |
| `ADMIN_ACCOUNT` 配置了但账号不存在 | 同上：没有人是管理员，打 WARN 并写明配的是哪个名字（掩码） |

## 测试

`npm test` 的 glob 目前是 `src/lib/*.test.ts src/db/*.test.ts src/sources/*.test.ts src/worker/*.test.ts src/app/wallet/*.test.ts src/app/wallet/login/*.test.ts`，**不覆盖 `src/app/api/`**。本次要把 `src/app/api/**/*.test.ts` 加进 glob，否则新写的路由测试根本不会跑。

必须覆盖的用例：

1. `isAdmin`：配置为空 → 全部 false；配置的名字匹配 → true；大小写与前后空格；账号为 null → false
2. `DELETE /api/tokens/[id]`：管理员删他人的 → 200；owner 删自己的 → 200；普通用户删他人的 → 403；普通用户删无主的 → 403；未登录 → 401
3. `PATCH /api/tokens/[id]`：
   - owner 改自己的 note → 200；普通用户改**他人的** note → 403；管理员改任何 note → 200；改无主的 note 非管理员 → 403
   - 普通用户改 enabled/frozen → 403；管理员 → 200
   - 任何登录用户改 pinned（含他人的、无主的）→ 200
   - **原子性**：同时提交 `{ note, enabled }` 且非管理员 → 403，且 **note 一并不写入**。部分成功会让人以为整个请求成功了，回头发现只改了一半
   - **原子性**：同时提交 `{ pinned, note }` 改他人的币 → 403，`pinned` 也不写入（单看 pinned 是允许的，但请求整体被拒）
4. `POST /api/tokens`：写入的 `owner_id` 等于当前账号 id，**不取请求体里的任何 user 字段**
5. 日历同构用例
6. `PUT /api/rules`：普通用户 → 403；管理员 → 200；`GET /api/rules` 普通用户 → 200
7. 中间件：豁免路径可达；其他路径无 `wallet_session` 时被拦
8. **回归护栏**：`POST /api/tokens` 与 `POST /api/events` 忽略请求体里的 `ownerId` / `owner_id` / `createdBy` 字段。这是隔离的命门 —— 一旦某个路由接受了客户端传来的归属，权限就名存实亡，任何人改个参数就能把币记到别人名下再以「自己的」删掉

## 风险

| 风险 | 评估 |
|---|---|
| 现有用户被登出 | **不会**。8 个账号都有活跃会话，TTL 30 天，最晚 10-02 过期。加列与中间件改动都不触碰 sessions 表 |
| 运维脚本被新闸门挡住 | **不会**。已核查 `scripts/*.ts` 全部直接操作数据库，没有一个走 HTTP API |
| 只用共享口令、没注册账号的人被挡在外面 | **会**，且**已确认可接受**。这类人数量查不到（口令是无状态比对，服务端无记录），他们需要注册 |
| 加列失败 | `ADDED_COLUMNS` 幂等，且部署前有自动备份 |
| 前端隐藏了按钮就以为安全 | 已在「执行点」里写明后端是唯一边界；测试用例直接打 API，不经过 UI |

## 明确不做

- **取消共享口令 / 注册邀请码 —— 是第二步，不在本文档实施范围**，但第一步的设计已确保不挡路（见「分两步走」）
- 多管理员、角色系统、权限组 —— 只有一个管理员，YAGNI
- 管理员在网页上提权/降权的界面 —— 改 `.env` 重启即可
- 把历史署名映射到账号 —— 见「历史数据」一节
- 审计日志（谁删了什么）—— 需要新表与新界面，本次不做；如果以后误删成为实际问题再单独立项
- 更改 `/wallet/login` 的路由路径 —— 会让现有书签失效
