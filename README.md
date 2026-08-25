# 多链代币回撤监控与抄底报警

设计规格见 [`drawdown-monitor-spec.md`](./drawdown-monitor-spec.md)，那是唯一的需求来源。

## 当前进度：Phase 2（数据准确性）

Phase 1：SQLite schema、DexScreener 适配器、30 秒全量轮询、`since_added` ATH、
单档 80% 回撤 + 状态机去重、Telegram 推送、Web 列表页。

Phase 2：GeckoTerminal OHLCV 回填（可断点续传）、`rolling_90d` + `all_time`、
原生币计价的完整序列、主池 6 小时粘性选举、5m→1h 汇总、失联通知、回填进度 UI。

Phase 3：多档位阶梯 [80/85/90/95]、代币详情页（K 线 + ATH 线 + 阈值线 + 报警标记、
三种 ATH 模式与双计价切换、池子列表、报警历史）。

**已砍掉（v1 不做）**：verdict 分类、反弹确认报警、多频道路由、PWA + Web Push。
这些属于决策辅助而非价格跟踪；报警消息已带足够的原始指标供人工判断。
相关数据字段（`verdict_basis`、`vol_h1_at_ath`、`local_low`）仍在计算并存库，
日后要加是现成的。

## 快速开始

```bash
npm install
cp .env.example .env        # 填入 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
npm start                   # 同时启动 worker 与 Web UI
```

然后打开 http://localhost:3000 ，其余操作都在网页上完成。
macOS 也可以直接**双击 `start.command`**，它会自动装依赖、启动、并打开浏览器。

## 网页能做什么

| 页面 | 用途 |
|---|---|
| `/` 看板 | 按回撤排序的清单；每行可改备注 / 冻结 / 停用 / 删除；回填进度；失联与错误横幅 |
| `/token/[id]` 详情 | K 线 + ATH 线 + 各档阈值线 + 报警标记；三种 ATH 模式与双计价切换；池子列表；报警历史 |
| `/add` 加币 | 粘地址或链接（DexScreener / GeckoTerminal / GMGN），批量、自动识别链、备注必填 |
| `/alerts` 报警 | 时间倒序，展开看触发时的完整快照 |
| `/settings` 设置 | 档位、ATH 模式、计价、确认次数、迟滞、冷却、最低流动性、k 值 |

## 命令

| 命令 | 说明 |
|---|---|
| `npm start` | **同时启动 worker 与 Web UI**（日常用这个） |
| `npm run worker` | 只启 worker |
| `npm run dev` | 只启 Web UI |
| `npm test` | 单元 + 集成测试 |
| `npm run typecheck` | tsc --noEmit |
| `npm run check:sources` | 数据源冒烟测试，不写库 |
| `npm run check:outliers` | 检查各代币跨池价格一致性（§2.4 离群池） |
| `npm run token:add` | 命令行加币（网页 `/add` 更方便） |

## 几条不可违反的约定

1. **价格算术一律 `decimal.js`**，价格列在 SQLite 里是 `TEXT`（十进制字符串）。
   数据源返回的就是字符串，全程 字符串 → Decimal → 字符串，两端都不经过 float。
   Memecoin 价格常在 1e-12 量级，浮点误差会让 79.98% / 80.02% 在阈值边界抖动。
2. **密钥掩码**：任何日志/报错/前端响应中的密钥都掩成前 4 后 4。
   唯一出口是 `src/lib/mask.ts`，新增输出路径时务必走它。`.env` 不入库。
3. **不实现任何交易/下单功能**，这是纯监控工具。
4. **静默失效比误报危险**：数据源空响应、代币长时间无报价、通知投递失败，
   全部显式抛出并暴露到 UI 与日志，不允许 try/catch 吞掉。

## Phase 0 踩到的坑（都已在规格 v0.3 中记录）

- DexScreener `/tokens/v1` 每代币只返回 1 个池，且**不是流动性最高的池**（WIF 实测差 39 倍），
  不能用于主池定价 —— 改用 `/token-pairs/v1`。
- legacy `/latest/dex/pairs` 大量返回 `{"pairs":null}`，不可作轮询主源。
- DexScreener 会**间歇性返回空数组且 HTTP 200 无 error 字段**，必须当作失败而非"无报价"。
- DexScreener 的 `priceNative` 是**池报价代币计价**，不是链原生币计价 ——
  同一个 BONK 在 USDC 池与 SOL 池之间该字段相差 9717%。故 `priceNative` 自行推导。
- 部分池的 USD 价格与流动性会被虚高约 **4950 倍**（实测 JUP、BONK），
  按流动性直接选主池会正好选中它 —— 需先做中位数离群剔除，见 §2.4。
- GeckoTerminal 免费档实测持续可用速率仅 **5 req/min**（12 秒间隔成功率 100%，8 req/min 降到 88%）。
  每代币 31 次请求（5m/90天 26 次 + 1h/180天 5 次），100 个代币全量回填约 **10 小时**，
  因此回填必须可断点续传、且独立于行情轮询。
- **GT 会省略无成交的 candle**，序列有间隔。按「前后 N 根」取窗口必须按时间戳而非数组下标。
- CoinGecko `market_chart` 的粒度随 `days` 变化：90 天是小时级，180 天只有日级。
- CoinGecko 免费档限流很紧，实时报价与历史回填必须共用一个限流队列，否则互相打成 429。
