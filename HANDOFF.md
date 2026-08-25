# 交接文档

给接手这个项目的人（或新一轮对话的 AI）。读完这份就能上手，不用翻聊天记录。

**仓库**：https://github.com/xueqiugunagun666-sketch/drawdown-monitor
**线上**：https://trashmonitor.duckdns.org
**规格**：[`drawdown-monitor-spec.md`](./drawdown-monitor-spec.md) —— 唯一需求来源，有分歧以它为准

---

## 1. 这是什么

单用户（小圈子共用）的多链代币回撤监控。跌到阈值推 Telegram。
**纯监控，不做交易** —— 这条是硬规则，不要加下单功能。

当前状态：Phase 1–3 全部完成并上线，4 个代币在跑。

---

## 2. 五分钟看懂架构

```
┌─ Web (Next.js 15) ──────────┐     ┌─ Worker（独立进程）──────────────┐
│  /          看板            │     │  poller  30 秒全量轮询          │
│  /add       加币            │     │  engine  写 candle → 算 ATH →   │
│  /alerts    报警历史        │     │          状态机 → 触发报警       │
│  /settings  规则配置        │     │  backfill 独立循环，补历史 K 线  │
│  /token/[id] K线详情        │     │  notifier Telegram              │
│  /login     口令登录        │     └─────────────┬───────────────────┘
└──────────┬──────────────────┘                   │
           └──────────► SQLite (WAL) ◄────────────┘
```

两个进程共享一个 SQLite 文件。worker 写，web 读。

**关键文件**

| 文件 | 职责 |
|---|---|
| `src/worker/engine.ts` | 主流程：每条报价走一遍 |
| `src/worker/ath.ts` | ATH 计算（size-k 最小堆），**纯函数** |
| `src/worker/athModes.ts` | 三种 ATH 模式的窗口切片 |
| `src/worker/stateMachine.ts` | 报警状态机，**纯函数** |
| `src/worker/backfill.ts` | 历史回填编排，可断点续传 |
| `src/sources/dexscreener.ts` | 实时行情（P0） |
| `src/sources/gmgn.ts` | OHLCV 回填（P0，快 20 倍） |
| `src/sources/geckoterminal.ts` | OHLCV 兜底（P1） |
| `src/sources/poolSelection.ts` | 离群池剔除，**纯函数** |
| `src/lib/decimal.ts` | 价格运算入口 |
| `src/lib/mask.ts` | 密钥掩码，**所有输出的唯一出口** |
| `src/lib/timezone.ts` | 时区换算（日历用），**纯函数** |
| `src/lib/eventInput.ts` | 日程输入校验，**纯函数** |
| `src/worker/reminders.ts` | 日程提醒 |
| `src/db/repo.ts` | 全部 SQL |

标了「纯函数」的都有对应 `.test.ts`，改逻辑先看测试。

---

## 3. 绝对规则（违反了整个工具就没用）

1. **价格算术一律 `decimal.js`，禁止 JS number。** 价格列在 SQLite 里是 `TEXT`
   存十进制字符串。数据源返回的就是字符串，全程 字符串 → Decimal → 字符串，
   两端都不经过 float。Memecoin 价格在 1e-12 量级，浮点误差会让
   79.98% / 80.02% 在阈值边界抖动。
2. **密钥掩码前 4 后 4。** 日志、报错、前端响应一律走 `src/lib/mask.ts`。
   `.env` 在 `.gitignore` 里，仓库只有 `.env.example`。
3. **不实现任何交易/下单功能。**
4. **静默失效比误报危险。** 数据源空响应、代币长时间无报价、投递失败，
   全部显式抛出并暴露到 UI 与日志，禁止 `try/catch` 吞掉。
5. **不过度设计。** 规格「已砍掉的范围」一节列的东西不要顺手加回来。

---

## 4. 踩过的坑（最有价值的部分，都有测试兜底）

这些全是线上真实事故，别再踩一遍。

### 数据源

| 坑 | 后果 | 现在怎么防 |
|---|---|---|
| DexScreener `/tokens/v1` 每代币只返回 1 个池，**且不是流动性最高的**（WIF 实测差 39 倍） | 主池定价完全错 | 只用 `/token-pairs/v1` |
| legacy `/latest/dex/pairs` 大量返回 `{"pairs":null}` | 不可作轮询主源 | 不用 |
| DexScreener **间歇性返回空数组且 HTTP 200 无 error** | 会被当成"该币没价格"，报警静默停摆 | 空响应一律抛 `SourceError` |
| 结果超 30 条时**静默丢弃**（请求 52 个只回 30） | 悄悄漏掉代币 | 按请求地址回映射校验覆盖率 |
| `priceNative` 是**池报价代币计价**，不是链原生币 | 同一个 BONK 在 USDC 池与 SOL 池差 9717% | `priceNative` 自行推导（§2.3） |
| 部分池 USD 价格与流动性**同时虚高约 4950 倍**（JUP、BONK） | 按流动性选主池会正好选中它 | 中位数离群剔除（§2.4） |
| GT 与 DexScreener 对同一池的 **base/quote 判定可能相反** | 回填取到对手方价格，差 16861 倍，产生 -99.99% 假报警 | OHLCV 按**代币地址**取价 + 量级兜底校验 |
| GT 免费档实测只有 **5 req/min**（文档称 30） | 100 币回填 10 小时 | 优先用 GMGN |
| GT **省略无成交的 candle**，序列有间隔 | 按「前后 N 根」取窗口会横跨数小时 | 一律按**时间戳**取窗口，不按数组下标 |
| GMGN 文档说 `from/to` 是 Unix 秒，**实际必须毫秒**；`from` 被忽略 | 传秒返回空数组 | 见 `gmgn.ts` 注释 |
| GMGN **限流按 IP 共享，不按 Key** | 多申请 Key 提速**无效**（实测验证） | 单一全局队列 |
| GMGN 触发限流后要 **292 秒**才恢复 | 秒级退避会白白重试完 | 退避 90s×attempt |
| GMGN `volume` 是美元、`amount` 是代币数量 | 差若干数量级 | vol_floor 用 volume |
| CoinGecko `market_chart` 粒度随 days 变：90 天小时级、180 天日级 | 精度不同 | 分段写入并用 source 区分 |
| CoinGecko 实时与历史各自直连会**互相打成 429** | 都失败 | 共用一个限流队列 |

### 逻辑

| 坑 | 后果 | 修法 |
|---|---|---|
| `all_time` 用 1h 而 `rolling_90d` 用 5m | 全历史 ATH 反而**低于** 90 天，违反 `all_time ⊇ rolling_90d` | `all_time = max(1h 全历史, 5m 近 90 天)` |
| 「代币比窗口年轻」被当成数据不完整 | 新币永远标「不完整」，误导 | 判据改为「最早 candle 是否明显晚于 max(窗口起点, 建池时刻)」 |
| 市值回撤用价格反推 | 等于假设供应量不变，算出来就是价格回撤换标签 | ATH 时刻市值未知就显示「未知」，不编 |
| 掩码正则用了 `\b` | `.../bot123456789:AAH...` 里 `t` 与 `1` 同为词字符，**真实 Telegram URL 反而匹配不上** | 去掉词边界断言 |
| worker 启动 `await` 原生币历史回填 | CoinGecko 一限流就把**价格轮询**一起堵住 | 改为后台执行 |

### 日历 / 用户名

| 坑 | 修法 |
|---|---|
| 用 `CET` / `EST` 这类缩写做时区换算 | **缩写不含夏令时信息**（CET 冬 UTC+1、夏 CEST UTC+2），一年里有半年差 1 小时。必须用 IANA 时区名让系统处理 |
| `NextResponse.cookies.set` 里手动 `encodeURIComponent` | Next 自己会编码，双重编码后读出来是 `%25E8%2580...`。去掉手动那次；**不要靠解码两次兼容**，那会让「100%赢」这类名字出错 |
| 日程链接直接渲染成 `<a>` | 必须校验只放行 http/https，否则 `javascript:` 就是 XSS |
| 改期后旧提醒记录还在 | 时间或提醒点变更时清空 `reminded_offsets`，否则新提醒点不触发 |

### 前端

| 坑 | 修法 |
|---|---|
| 图表容器挂载瞬间宽度为 0，`fitContent()` 静默失效且不自愈 | 数据与宽度**两个条件都就绪**才 fit，由 ResizeObserver 驱动 |
| 用 `requestAnimationFrame` 补救 | rAF 在**非可见标签页里不触发**，更糟 |
| 图表在 fetch 之后才创建 | StrictMode 双挂载留下两个实例，代码握着的是已分离那个，所有 API 调用变空操作 | 同步建图、异步只喂数据 |
| 90 天视图取了全部 1h candle（实际 146 天） | 更早的高点把价格轴撑坏 | 按模式窗口裁剪；显示粒度与计算粒度分离 |
| 回撤为负时显示 `--1%` | `ath_robust` 是第 k 高 close，现价可能高于它 | 负值显示 `+X%` |

---

## 5. 运维

### 服务器

新加坡腾讯云轻量 2核2G/50G，Ubuntu 24.04。**地域必须境外** —— 国内连不上
DexScreener / GeckoTerminal / Telegram，`install.sh` 第一步会检测并中止。

```bash
ssh ubuntu@43.156.129.48          # 已配置密钥免密（本机 ~/.ssh/config 里别名 drawdown）
```

三个 systemd 服务：`drawdown-worker` / `drawdown-web` / `caddy`。
应用只监听 `127.0.0.1:3000`，公网流量全经 Caddy（自动 HTTPS）。
防火墙只开 80 / 443，**不要开 3000**。

### 常用命令

```bash
journalctl -u drawdown-worker -f                      # 看日志
systemctl restart drawdown-worker drawdown-web        # 重启
systemctl start drawdown-backup                       # 立即备份
ls -lh /opt/drawdown-monitor/backups                  # 每日备份，留 7 天
```

### 更新代码

```bash
cd /tmp/dm && sudo git pull
sudo rsync -a --exclude node_modules --exclude .next --exclude data \
  --exclude backups --exclude .env --exclude .git /tmp/dm/ /opt/drawdown-monitor/
sudo chown -R drawdown:drawdown /opt/drawdown-monitor
cd /opt/drawdown-monitor
sudo -u drawdown npm run db:migrate   # 有新列时会自动 ALTER，不会丢数据
sudo -u drawdown npm run build
sudo systemctl restart drawdown-worker drawdown-web
```

### 本地命令

```bash
npm start                    # 同时起 worker + 网页（或双击 start.command）
npm test                     # 66 个测试
npm run typecheck
npm run check:sources        # 数据源冒烟测试
npm run check:telegram       # Telegram 自检，只读不发消息
npm run test:alerts -- 2     # 发测试报警，加 --dry 只本地渲染
npm run repair -- <chain:addr>  # 清掉某代币被污染的历史，重新回填
npm run bench                # 引擎耗时基准
```

---

## 6. 密钥

全在 `/opt/drawdown-monitor/.env`（权限 600，不入 git）：

| 变量 | 用途 |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 推送 |
| `ACCESS_TOKEN` | 网页登录口令 |
| `GMGN_API_KEY` | OHLCV 回填；不配则自动用 GeckoTerminal |
| `COINGECKO_API_KEY` | 可选，免费档留空 |

> **待办**：`TELEGRAM_BOT_TOKEN` 与 `GMGN_API_KEY` 都在聊天记录里明文出现过，
> 建议各重置一次。改 `.env` 对应行后 `systemctl restart drawdown-worker` 即可。

GMGN 只读接口**不需要私钥**（私钥只有下单类接口才要，本项目不做交易）。

---

## 7. 有意不做的事

见规格「已砍掉的范围」一节。简述：

- **verdict 分类（🟢🟡🔴）** —— 报警已带足原始指标供人工判断，
  启发式标签不值这个复杂度。`verdict_basis` / `vol_h1_at_ath` 仍在算并存库，
  日后要加是现成的。
- **反弹确认报警（bounce）** —— `alert_rules.type`、`alert_states.local_low`
  字段已预留并在维护。
- **多频道路由**、**PWA + Web Push**
- **用户系统** —— 共用一份清单 + 一个口令。知道口令的人都能加删币，
  且不记录是谁操作的。只把口令给信得过的人。
- **主池粘性** —— 原 §2.4 的「6 小时重选」「跌破总流动性 50% 切换」已移除：
  后者对流动性分散的代币根本不成立（BONK 领先池仅占 20%，永远满足不了）。
  现在每轮直接取剔除离群后流动性最高的池。

---

## 8. 加新功能时

1. **先读规格对应章节**，有冲突先改规格再改代码
2. **纯逻辑抽成纯函数 + 测试**，别把判断埋在 IO 里
3. **价格碰 Decimal，密钥碰 mask，失败要抛出**
4. **本地 `npm test` + `npm run build` 通过再部署**
5. 数据库加列走 `src/db/migrate.ts` 的 `ADDED_COLUMNS`，会自动 ALTER

### 通知层复用

要发非报警类通知（如日历提醒），用 `src/worker/notifier.ts` 的 `notifyPlain(text)`，
它已经处理好掩码、重试与失败留痕。不要另起一套发送逻辑。
