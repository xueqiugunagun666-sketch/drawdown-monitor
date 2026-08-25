# 多链代币回撤监控与抄底报警系统 — 设计规格

> 交付对象：Claude Code
> 版本：v0.3
> 目标链：Ethereum / Base / BSC / Solana / Robinhood Chain

**v0.3 变更（Phase 0 验证后）**：`ath_robust` 改为「合格 candle 中第 k 高的 close」，删除连续水位规则（§2.2）；`priceNative` 改为自行推导 + `native_prices` 表（§2.3）；确认 `/tokens/v1` 不可用于主池定价，改用 `/latest/dex/pairs` + `/token-pairs/v1` 双端点（§2.4/§4.3/§5）；`ath_liquidity` 缺失时用 `volume_ratio` 替代且不降级 verdict（§2.5）；删除 `ath_state.window_deque`；Robinhood 确认走 DexScreener P0。

**v0.2 变更**：确认 Robinhood Chain 数据源 → 移除自建链上读价的必要性；清单规模确定 < 100 → 移除分级轮询；默认 ATH 模式改为 90 天滚动；移除 CEX 行情源考量。

---

## 1. 目标与非目标

### 目标
- 维护一个跨链代币观察清单（< 100 个），用 `chain:address` 唯一标识
- 持续追踪每个代币的最高价与当前价，计算回撤幅度
- 回撤达到阈值（默认 80%，可全局设置 + 单代币覆盖）时推送报警
- 报警必须携带**决策信息**——能一眼分辨这是回调还是归零
- Web 界面多设备访问 + Telegram 推送

### 非目标
- 不做自动交易 / 下单
- 不做代币发现（清单由人工筛选后加入）
- 不做持仓管理与盈亏统计
- 不接 CEX 行情（只针对 DEX 抄底）

> 关于 CEX：清单里若有已上主流 CEX 的币，DEX 价格可能偏离主要价格发现场所。不额外接数据源，但 UI 上如果 DexScreener 返回的流动性异常低于该币知名度预期，仅作展示提示，不影响报警逻辑。

---

## 2. 核心设计难点（实现前必须先解决）

这一节是整个系统的价值所在，实现时优先处理。

### 2.1 「最高点」到底指什么

同一个代币，三种定义会给出完全不同的回撤数字：

| 模式 | 含义 | 说明 |
|---|---|---|
| **`rolling_90d`** | **滚动 90 天窗口内最高（默认）** | 避免远古高点污染。2021/2024 周期的老币用 `all_time` 会永久停在 -95%，报警系统对它们直接失效 |
| `all_time` | 建池以来最高 | 可选。适合新币，或想看完整跌幅时 |
| `since_added` | 加入清单以来最高 | 可选。追踪自己关注之后的走势 |

**设计决定**：三种同时计算并存储，报警规则指定用哪个；**默认 `rolling_90d`**，UI 上三个数字并列显示。

`rolling_90d` 的实现：维护 90 天 5m candle，ATH = 窗口内最大值，窗口滑出时重算。为避免每轮全量扫描，用**单调递减队列**维护窗口最大值，O(1) 更新。

冷启动回填：通过 GeckoTerminal OHLCV 端点（`/networks/{network}/pools/{pool}/ohlcv/{timeframe}`，支持 day/hour/minute + aggregate，最多回溯 6 个月）拉取。

**两条序列，粒度不同**（实测每次请求最多返回 1000 根）：

| 服务的模式 | 序列 | 覆盖 | 请求数 |
|---|---|---|---|
| `rolling_90d` / `since_added` | **5m** | 90 天 | 26 |
| `all_time` | **1h 全历史 + 5m 近 90 天取较高者** | 180 天（GT 历史深度上限） | 5（复用上面的 5m） |

**`all_time` 必须满足 `all_time >= rolling_90d`。** 若只用 1h 会违反这个不变量：
1h 的 close 是每小时最后一根 5m 的 close，漏掉小时内尖峰；而 `ath_robust`
取「第 k 高的 close」，样本量从 3250 根降到 271 根后该统计量必然更低。
线上实测：某 11 天大的代币，`all_time`（1h）算出 0.071625，反而低于
`rolling_90d`（5m）的 0.074863 —— 而两者覆盖的时间段其实完全相同。

因此 `all_time` = max(1h 全历史, 5m 近 90 天)，两边各自在自己的粒度内
一致地计算再取较高者：既保住不变量，又不必为 `all_time` 额外拉 52 次 5m。
`rolling_90d` 必须用 5m —— 与实时段粒度一致，否则窗口滑动时 ATH 的严格度会悄悄改变（§2.2）。

**回填必须可断点续传**：GT 免费档实测持续可用速率仅 **5 req/min**（12 秒间隔时成功率 100%，8 req/min 降到 88%）。每代币 31 次请求，100 个代币约 **10 小时**，中途重启不能从头再来。用 `backfill_jobs` 表记录 `oldest_done_ts` 逐页续传，且回填循环独立于 30 秒行情轮询，不得互相阻塞。

**GT 会省略无成交的 candle**，返回序列存在间隔。任何按「前后 N 根」取窗口的逻辑都必须按**时间戳**而非数组下标，否则稀疏数据下窗口会横跨数小时。

`all_time` 模式下若建池早于 6 个月，标记 `backfill_partial = true`，UI 上明确标识，不要假装数据完整。

> **代币比窗口年轻 ≠ 数据不完整。** 池子 11 天前才建，90 天窗口自然只有 11 天数据，
> 但那已经是存在的全部，此时标「不完整」是误导。判据应为：
> 最早 candle 的时刻是否明显晚于 `max(窗口起点, 建池时刻)`。
> 只有数据源确实还有更早数据却拿不到时，才算不完整。

### 2.2 插针高点污染（必须处理）

Memecoin 单区块拉盘极常见。如果 ATH 被一根针钉死，之后所有回撤都会永远显示 -95%，报警失效。

**双轨 ATH**：
- `ath_raw` = max(candle.high)，仅作展示
- `ath_robust` = **窗口内满足 `volume_usd >= vol_floor` 的 candle 中，第 k 高的 `close`**
  - `vol_floor` = 同窗口内**非零 volume** candle 的**中位数 × 0.1**
  - `k` = 配置项 `ath_sustain_candles`，**默认 3**

**实现**：size-k 最小堆。遍历窗口内合格 candle，堆大小超过 k 时弹出堆顶；遍历结束后堆顶即为第 k 高 close。**回填与实时必须共用同一段代码**——历史段与实时段若用不同标准，窗口滑动时 ATH 的严格度会悄悄改变，这是最难排查的一类 bug。

> 已删除原「价格在 ≥ 2 根连续 5m candle 上维持在该水位的 80% 以上」规则。

**流动性与成交笔数不再参与 `ath_robust` 判定**（GT OHLCV 历史数据不提供这两个字段，见 Phase 0 验证结论）。改为记录：

- `ath_confidence`：`'verified'`（ATH candle 来自实时轮询，流动性/笔数已知）| `'inferred'`（来自 OHLCV 回填，仅有 OHLCV 六字段）
- **仅用于展示**，不影响报警触发

**报警一律基于 `ath_robust`**。UI 同时展示 `ath_raw` / `ath_robust` 与差距（差距大 = 有插针史，人工留意），并展示 `ath_confidence`。

**窗口滑动重算规则（强制）**：90 天窗口滑动导致 ATH 所在 candle 改变时，必须**整组重算** `ath_liquidity` / `vol_h1_at_ath` / `ath_confidence` / `verdict_basis`，**不得沿用旧值**。这四个字段绑定在具体那根 ATH candle 上，ATH 换了它们全部失效。

**Phase 2 标定**：比对脚本需同时输出 `k=3` 与 `k=6` 的结果，供人工选定最终默认值。

### 2.3 计价单位：USD 还是原生币

一个 SOL 生态代币，SOL 从 200 跌到 100 时，USD 计价 -80% 可能只等于 SOL 计价 -60%。抄底逻辑上你往往在意后者。

**设计决定**：`priceNative` **不取数据源字段，自行推导**：

```
priceNative = priceUsd / nativeCoinUsdPrice
```

> 原因（Phase 0 实测）：DexScreener 的 `priceNative` 是**该池报价代币计价**，不是链原生币计价——USDC 池里 `priceNative == priceUsd`。同一个 BONK 在 USDC 池与 SOL 池之间，该字段相差 9717%。叠加 §2.4 的 primary pool 每 6 小时重选，一旦主池从 SOL 池切到 USDC 池，`drawdown_native` 的含义会**静默改变**，直接产生错误报警。GT 的 `base_token_price_native_currency` 语义正确，但其免费限流实测仅 5–8 req/min，不足以支撑实时轮询。

**`native_prices` 表**存 ETH / BNB / SOL 的 USD 报价：
- **实时**：60s 刷新，`source='coingecko'`
- **历史**：CoinGecko `market_chart` 的粒度随 `days` 变化（实测），因此分两段写入且精度必须可分辨：

| 区间 | days | 原始粒度 | source | 服务的模式 |
|---|---|---|---|---|
| 0–90 天 | 90 | **小时级**（2161 点） | `coingecko_hourly` | `rolling_90d` / `since_added` |
| 90–180 天 | 180 | **日级**（181 点） | `coingecko_daily` | 仅 `all_time`，精度较低 |

均插值到 5m。写入顺序为先日级后小时级，重叠区间由小时级覆盖；实时值永不被历史覆盖。

> **回填出的 candle 必须逐页补 native 计价**（`priceNative = priceUsd / nativeUsd(ts)`）。
> 漏补的话 native 的 ATH 窗口会比 USD 短几个数量级，而且从 `ath_confidence` 上完全看不出来。
>
> CoinGecko 免费档限流很紧：实时报价与历史回填若各自直连会互相打成 429，
> 所有 CoinGecko 请求必须走同一个限流队列。
- 各链原生币映射：ethereum → ETH，base → ETH，bsc → BNB，solana → SOL，robinhood → ETH

**默认 `quote_mode = 'usd'`；`drawdown_native` 为展示字段**，报警消息里两个都带上。

> ⚠️ 实现时在代码注释中注明：**若将来以 native 作为报警依据，此序列需补 §2.2 同级的健壮性处理**（当前 native 序列没有 vol_floor / 第 k 高 close 的插针过滤，直接拿来报警会重蹈 2.2 的覆辙）。

### 2.4 多池聚合

同一代币可能在多个 DEX / 多个池子交易。**保留全池聚合。**

**Phase 0 验证结论**：`/tokens/v1/{chain}/{addresses}` **不返回全部 pair**，每个代币只返回 **1 个**，且**不是流动性最高的那个**（WIF 实测：该端点返回 $142k 的池，真实主池 $5.5M，差 39 倍）。因此：

**单端点方案**：`/token-pairs/v1/{chainId}/{tokenAddress}` 一次调用即同时给出全部池、主池价格、`liquidity_total`，无需第二个端点。

| 用途 | 端点 | 批量 | 频率 |
|---|---|---|---|
| 池发现 + primary 选举 + 主池价格 + `liquidity_primary/total` + txns/volume | `/token-pairs/v1/{chainId}/{tokenAddress}` | 1 代币/次 | **30 秒一轮** |

> 实测吞吐：并发 6 跑出 **1109 req/min 零 429**。100 代币 × 30 秒 = 200 req/min，余量充足。
>
> **不要用 `/latest/dex/pairs/{chainId}/{poolAddresses}`**：legacy `/latest/dex/` 系列极不稳定，实测单池地址查询连续 15 次全部返回 `{"pairs":null}`，批量形式时对时错，不可作为轮询主源。

> `/token-pairs/v1` 返回上限亦为 30 个 pair，故 `liquidity_total` 实为「流动性前 30 池之和」。对 <100 个代币的清单，尾部池占比可忽略，但 UI 措辞应为「主要池合计」而非「全部池」。

#### 离群池剔除（必须，先于 primary 选举）

DexScreener 会对某些池给出错误的报价代币定价，导致该池的 **USD 价格与 USD 流动性同时虚高约 4950 倍**。实测 6 个代币中招 2 个，且都是主流币：

| 代币 | 跨池最大价格偏离 | 按流动性直接选出的主池 | `liquidity_total` 虚高 |
|---|---|---|---|
| JUP | 4968x | meteora/MET $1014.61（真实 $0.205） | **185.67x** |
| BONK | 4948x | raydium/RAY $0.01563（真实 $0.00000316） | 5.84x |
| WIF / PEPE / BRETT / CASHCAT | 1.0–1.3x | 正常 | 1.00x |

不剔除的后果：价格错 ~4950 倍使回撤计算完全失效；`liquidity_total` 虚高使 `min_liquidity_usd` 门槛形同虚设，§2.5 的 `liq_now / liq_at_ath` 同样失真。

**算法**：

1. 取全部 base 池 `priceUsd` 的**不加权中位数** `median_price`
2. 池价与中位数的比值落在 `[1/poolPriceDeviationMax, poolPriceDeviationMax]` 之外者标记为**离群池并排除**
   - `poolPriceDeviationMax` 默认 **1.5**
3. `primary_pool` = **剩余池中**流动性最高者
4. `liquidity_total` = **仅对剩余池**求和
5. 被排除的池必须记录原因并暴露到 UI 与日志（绝对规则 4，不得静默丢弃）

> **中位数必须不加权。** JUP 的坏池占了 $423M 总流动性中的 $421M，流动性加权中位数会被坏池带跑，直接失效。
>
> **1.5x 的安全边际**：健康代币跨池真实价差仅 1.0–1.3x，坏池约 4950x，中间隔三个数量级，不存在误伤。

**池数 < 3 时不做剔除**（无法交叉验证：1 个池时中位数就是它自己；2 个池互差超阈值时无法判断谁对），但须置 `cross_validated = false`，UI 明确标注「无交叉验证」。

- 每个代币选一个 `primary_pool` = **离群剔除后**流动性最高的池（**从 `/token-pairs/v1` 结果中选，不能用 `/tokens/v1`**）
- **每轮直接取，不做粘性、不做定期重选。** 流动性接近的两个池价差约 0.15%，
  对 80% 的阈值没有影响，为它引入粘性状态机得不偿失
- 主池发生变化时记一条日志，不做特殊处理
- 价格取 primary pool，流动性同时记录两个值

> 原「每 6 小时重新评估」与「流动性掉到全部池子 50% 以下立即切换」已移除。
> 后者对流动性分散的代币根本不成立 —— BONK 有 30 个池、领先池仅占 20%，
> 永远无法满足该条件，粘性从不生效。规则不成立就不如不要。

**`candles` 与 `snapshot` 同时存 `liquidity_primary` 与 `liquidity_total`。**

- **`min_liquidity_usd` 门槛用 `liquidity_total`**
- 当 `liquidity_primary / liquidity_total < 0.5` 时，**报警中加标注**（主池不占多数，价格代表性下降）

### 2.5 抄底 vs 归零

-80% 有两种完全不同的含义：健康回调 / 项目死了。报警必须帮你区分。

**触发时计算「抄底可行性快照」**（不做预测，只呈现事实）：

| 指标 | 计算方式 | 危险信号 |
|---|---|---|
| **流动性变化** | `liq_total_now / ath_liquidity` | < 0.2 → 疑似撤池 |
| **成交量变化（替代基准）** | `vol_h1_now / vol_h1_at_ath` | < 0.2 → 盘面枯竭 |
| 近 1h 交易笔数 | `txns.h1.buys + sells` | 0 → 死盘 |
| 买卖比 | `txns.h1.buys / sells` | < 0.3 → 单边砸盘中 |
| 距 ATH 时长 | `now - ath_ts` | < 1h → 还在瀑布中，别接 |
| 持有人数变化 | GeckoTerminal holders chart | 持续下降 → 出货 |
| 合约风险 | Solana: mint/freeze authority；EVM: owner / LP 是否 burn | 权限未弃 → 高风险 |

**`ath_liquidity` 为 NULL 时（ATH 来自 OHLCV 回填），改用 `volume_ratio` 进入 verdict 判定**：

- `vol_h1_at_ath` = ATH candle **前后各 6 根**（共 1 小时）的 `volume_usd` 求和
- 阈值形状沿用流动性那套（< 0.2 危险 / > 0.6 健康）
- **不因此降级 verdict——该给 🟢 就给 🟢**

> 理由：新加入的代币高点全部来自回填，无条件降级会让 verdict 在最需要它的时候恒为 🟡。

`snapshot` 增加 **`verdict_basis`: `'liquidity'` | `'volume_proxy'`**，UI 与 Telegram 消息标注依据来源。

汇总为三档标签，写进报警标题：
- `🟢 可能是回调` — 基准比值 > 0.6、仍有双向成交、距 ATH > 6h
- `🟡 需要人工判断` — 其余情况
- `🔴 疑似 rug / 死盘` — 基准比值 < 0.2 或 1h 零成交

**注意**：这是启发式分类，不是判断依据。UI 与报警消息必须展示原始指标，不能只给标签。

**窗口滑动重算**：见 §2.2 末尾的强制重算规则——ATH candle 改变时 `ath_liquidity` / `vol_h1_at_ath` / `verdict_basis` 必须整组重算。

### 2.6 报警去重与重新武装

**状态机（每个 `(token, threshold_level)` 独立）**：

```
ARMED ──(drawdown ≥ threshold 连续 confirm_ticks 次 且 liq ≥ min_liq)──> FIRED
FIRED ──(drawdown ≤ threshold - hysteresis 持续 rearm_minutes)──> ARMED
```

- `threshold_levels` 默认 `[80, 85, 90, 95]`，每档独立触发一次
- `confirm_ticks` 默认 2
- `hysteresis` 默认 15（百分点）
- `rearm_minutes` 默认 60
- 全局 `alert_cooldown` 默认 30 分钟（同一代币任意档位之间的最小间隔）

### 2.7 反弹确认报警（Phase 3，架构需预留）

回撤 80% 报警时通常还在下跌中，不是买点。真正的入场信号是「跌够了 + 开始反弹」。

规则类型 `bounce`：代币进入 FIRED 后，若价格从局部低点回升 ≥ X%（默认 25%）且 1h 买单笔数 > 卖单笔数，触发第二次报警。**这个报警的实用价值大概率高于回撤报警本身**，数据结构从 Phase 1 就要留好（`alert_rules.type` 字段、局部低点追踪）。

---

## 3. 系统架构

```
┌─────────────────────────────────────────────────────┐
│                     Web UI (PWA)                     │
│         Next.js App Router / 移动端可加桌面           │
└────────────────────┬────────────────────────────────┘
                     │ REST + SSE
┌────────────────────▼────────────────────────────────┐
│                  API (Next.js Route Handlers)        │
│   watchlist CRUD / 规则配置 / 历史查询 / 实时推送      │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│                    SQLite (WAL)                      │
│ tokens / pools / candles / ath_state / rules / alerts│
└────────────────────▲────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────┐
│                  Worker (独立进程)                    │
│  ┌──────────┐  ┌───────────┐  ┌─────────────────┐  │
│  │ Scheduler│─>│ Price Feed│─>│ Drawdown Engine │  │
│  │ 全量轮询  │  │ 多源适配器 │  │ ATH + 状态机     │  │
│  └──────────┘  └───────────┘  └────────┬────────┘  │
│                              ┌──────────▼────────┐  │
│                              │ Notifier          │  │
│                              │ Telegram/WebPush  │  │
│                              └───────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**技术栈**
- TypeScript（Node 20+），全栈一套类型
- Web：Next.js 15 App Router + Tailwind + shadcn/ui，PWA manifest + Service Worker
- API：Next.js Route Handlers（单体部署最简单）
- Worker：独立 `worker.ts` 进程，docker-compose 起两个 service
- DB：SQLite + better-sqlite3 + Drizzle ORM（100 个代币的规模，上 Postgres 只是增加运维负担）
- 图表：lightweight-charts
- 限流：p-queue（不引入 Redis）

---

## 4. 数据源

### 4.1 适配器接口

```ts
interface PriceSource {
  id: string;
  supportsChain(chain: ChainId): boolean;
  maxBatchSize: number;
  rateLimitPerMin: number;
  fetchQuotes(chain: ChainId, addresses: string[]): Promise<TokenQuote[]>;
  fetchOHLCV?(pool: PoolRef, tf: Timeframe, before?: number): Promise<Candle[]>;
}

interface TokenQuote {
  chain: ChainId;
  address: string;
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number;
  fdvUsd: number | null;
  volume: { m5: number; h1: number; h24: number };
  txns: { m5: Txns; h1: Txns; h24: Txns };
  primaryPool: PoolRef;
  allPools: PoolRef[];
  fetchedAt: number;
  source: string;
}
```

### 4.2 数据源与链的映射（已核实）

| 链 | DexScreener chainId | GeckoTerminal network id | 主源 |
|---|---|---|---|
| Ethereum | `ethereum` | `eth` | DexScreener |
| Base | `base` | `base` | DexScreener |
| BSC | `bsc` | `bsc` | DexScreener |
| Solana | `solana` | `solana` | DexScreener |
| Robinhood Chain | **`robinhood`（已验证支持）** | `robinhood` | **DexScreener** |

**Robinhood Chain 已确认信息**：
- GeckoTerminal network id = `robinhood`，token/pool 资源 id 格式为 `robinhood_0x...`
- 主要 DEX 为 Uniswap V4 系（dex id `uniswap-v4` 或其变体）
- EVM chain ID = 4663，Arbitrum Nitro L2，ETH 为 gas 币
- 公开 RPC：`https://rpc.mainnet.chain.robinhood.com`；浏览器：`robinhoodchain.blockscout.com`

**Phase 0 验证结论（2026-08-24 实测）**：

- ✅ GT `robinhood` 网络可用，返回 20 池
- ✅ **DexScreener 支持 `robinhood` chainId** → Robinhood 与其他四链**统一走 P0**，GT 仅作兜底与 OHLCV 回填
- 实测 DEX id 为 `uniswap-v3-robinhood` / `uniswap-v2-robinhood` / `pons-dot-family` / `pons-v2-dex` / `giga-v3` / `uniswap-pools-trade`，**不是 Uniswap V4**（附录 A 的 `StateView.getSlot0` 方案与实际不符，v1 不实现故不影响）
- 同池双源价差：CASHCAT DS $0.1877 vs GT $0.1906（-1.53%）；BONK -0.22%；WIF -0.06%。**USD 价格可混用**，native 价格不可（见 §2.3）

### 4.3 数据源优先级

| 优先级 | 数据源 | 限制 | 用途 |
|---|---|---|---|
| P0 | DexScreener `/token-pairs/v1/{chainId}/{tokenAddress}` | **1 代币/次**，返回上限 30 pair；实测 >1000 req/min 无 429 | **主实时行情**：全部池 + 主池价 + `liquidity_primary/total` + txns/volume |
| P1 | GeckoTerminal `/networks/{net}/tokens/multi/{addresses}` | 30 地址/次，**超 30 返回 HTTP 400**；实测限流 **5–8 req/min**（文档称 30） | 兜底 |
| P0 | GMGN `/v1/market/token_kline` | 1000 根/次；实测**串行 ~100 req/min 零 429**；**限流按 IP 共享而非按 Key** | **OHLCV 回填主源**（比 GT 快 20 倍） |
| P1 | GeckoTerminal `/networks/{net}/pools/{pool}/ohlcv/{tf}` | `limit` 上限 **1000**（=3.47 天 @5m）；时间戳为**秒**、**倒序**；`before_timestamp` 分页**边界包含**需去重；5m 实测可回溯 ≥180 天 | ATH 历史回填 |

> **不要用 `/tokens/v1/{chainId}/{addresses}`**：每代币只返回 1 个 pair，且不是流动性最高的池（WIF 实测差 39 倍），无法用于 primary pool 定价或流动性聚合。
>
> **不要用 `/latest/dex/pairs/...`**：legacy 端点，实测大量返回 `{"pairs":null}`。

**GMGN 实测要点**（文档与实际有出入，以实测为准）：

- 只读接口**不需要签名**，但 query 必须带 `timestamp`（Unix 秒）与 `client_id`（UUID），
  少任一个返回 401 `AUTH_INVALID`。签名只有下单类接口才要，本项目永不使用。
- 翻页参数是 **`to`，单位毫秒**（文档写 "Unix seconds" 是错的，传秒返回空数组）；
  `from` 被完全忽略。
- **限流按 IP 共享，不按 Key**：实测把公共 Key 打爆后，同一 IP 上的个人 Key
  立刻一起 429。因此多申请 Key 提速**无效**，只维护一个全局队列。
- 触发限流后约 **292 秒**才恢复，退避必须是分钟级。
- 字段陷阱：`volume` 是**美元金额**，`amount` 是**代币数量**，两者差若干数量级。
- 与 DexScreener 交叉验证：三个代币价格比值 0.994–1.002，可安全混用。

> **静默失效（实测，对应总则 4）**：DexScreener 两个端点均会**间歇性返回 `[]` 且 HTTP 200、无 error 字段**；`/tokens/v1` 超过 30 条结果时**静默丢弃**（请求 52 地址只回 30，丢 22 个不报错）。适配器必须按请求地址回映射并校验覆盖率，**空响应与缺失一律当作数据源失败上报，不得当作「无报价」**。
| P2 | 链上直读（viem multicall / Solana RPC） | 需自备 RPC | 仅在前两者同时失效时启用 |

**P2 已降级为可选**。Robinhood Chain 有 GeckoTerminal 覆盖后，v1 不需要实现自建 Uniswap V4 读价。若日后确实需要（比如 GT 索引延迟太大），实现要点保留在附录 A。

### 4.4 降级与失联检测

- 每个代币记录 `last_good_source` 与 `consecutive_failures`
- P0 连续失败 3 次自动降级到 P1，成功 10 次后恢复
- 价格写入时带 `source` 字段，UI 显示当前数据源
- **任何代币超过 `stale_minutes`（默认 15）无有效报价 → UI 高亮 + 发一条「数据源失联」通知。静默失效比误报更危险。**

---

## 5. 轮询调度（已简化）

清单 < 100 个，全量高频轮询完全在预算内，**不需要分级**。

**预算计算**（100 个代币，按链分布 eth 30 / base 20 / bsc 10 / solana 30 / robinhood 10）：

- **行情 + 池聚合**（30 秒一轮，单端点）：`/token-pairs/v1`，1 代币/次 → 每轮 100 次 → **200 req/min**
- **原生币报价**（60 秒一轮，见 §2.3）：CoinGecko 3 个 symbol 一次 → **1 req/min**

对 DexScreener 合计 **200 req/min**。实测该端点并发 6 可达 1109 req/min 且无 429，余量约 5 倍。
worker 用 p-queue 限并发 6，避免突发打满。

**结论**：统一 30 秒轮询间隔，余量充足。若日后清单涨到 300+ 再考虑分级。

**唯一保留的分级**：`frozen` 状态——所有档位已触发 + 1h 零成交 + 流动性 < $1k 的代币降到 6 小时一次，纯粹为了减少无意义的 API 调用和 UI 噪音。可在 UI 上一键解冻。

```ts
const POLL_INTERVAL_MS = 30_000;
const FROZEN_INTERVAL_MS = 6 * 3600_000;

// 每轮：按 chain 分组 → 按 maxBatchSize 切片 → p-queue 并发受限执行
```

---

## 6. 数据模型

```sql
CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,       -- "{chain}:{address}"
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  symbol        TEXT,
  name          TEXT,
  decimals      INTEGER,
  added_at      INTEGER NOT NULL,
  note          TEXT,                   -- 备注：为什么关注它（人工筛选的理由）
  tags          TEXT,                   -- JSON array
  frozen        INTEGER DEFAULT 0,
  enabled       INTEGER DEFAULT 1,
  last_source   TEXT,
  last_quote_at INTEGER,
  fail_count    INTEGER DEFAULT 0
);

CREATE TABLE pools (
  id            TEXT PRIMARY KEY,       -- "{chain}:{poolAddress}"
  token_id      TEXT NOT NULL REFERENCES tokens(id),
  dex           TEXT,
  quote_symbol  TEXT,
  quote_address TEXT,
  is_primary    INTEGER DEFAULT 0,
  liquidity_usd REAL,
  created_at    INTEGER
);

-- 5m 保留 120 天（覆盖 90 天窗口 + 余量）；1h 永久
CREATE TABLE candles (
  token_id   TEXT NOT NULL,
  timeframe  TEXT NOT NULL,             -- '5m' | '1h' | '1d'
  ts         INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL,
  o_native REAL, h_native REAL, l_native REAL, c_native REAL,
  volume_usd REAL,
  liquidity_primary REAL,          -- 主池流动性
  liquidity_total   REAL,          -- 主要池合计（/token-pairs/v1 前 30 池之和）
  txn_count INTEGER,               -- 回填段为 NULL（GT OHLCV 不提供）
  PRIMARY KEY (token_id, timeframe, ts)
);

CREATE TABLE ath_state (
  token_id        TEXT NOT NULL,
  mode            TEXT NOT NULL,        -- 'rolling_90d' | 'all_time' | 'since_added'
  quote_mode      TEXT NOT NULL,        -- 'usd' | 'native'
  ath_raw         REAL,
  ath_robust      REAL,                 -- 2.2 节：合格 candle 中第 k 高的 close
  ath_ts          INTEGER,
  ath_liquidity   REAL,                 -- 高点时的流动性；回填段为 NULL
  vol_h1_at_ath   REAL,                 -- ATH candle 前后各 6 根 volume 之和，ath_liquidity 为 NULL 时的替代分母
  ath_confidence  TEXT,                 -- 'verified' | 'inferred'，仅展示
  verdict_basis   TEXT,                 -- 'liquidity' | 'volume_proxy'
  backfill_partial INTEGER DEFAULT 0,
  updated_at      INTEGER,
  PRIMARY KEY (token_id, mode, quote_mode)
);

-- 2.3 节：priceNative 自行推导，不取数据源字段
CREATE TABLE native_prices (
  symbol     TEXT NOT NULL,             -- 'ETH' | 'BNB' | 'SOL'
  ts         INTEGER NOT NULL,          -- 5m 对齐
  price_usd  REAL NOT NULL,
  source     TEXT,                      -- 'coingecko' | 'realtime'
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE alert_rules (
  id           TEXT PRIMARY KEY,
  token_id     TEXT,                    -- NULL = 全局默认规则
  type         TEXT NOT NULL,           -- 'drawdown' | 'bounce'
  ath_mode     TEXT DEFAULT 'rolling_90d',
  quote_mode   TEXT DEFAULT 'usd',
  levels       TEXT NOT NULL,           -- JSON: [80,85,90,95]
  confirm_ticks INTEGER DEFAULT 2,
  hysteresis   REAL DEFAULT 15,
  rearm_minutes INTEGER DEFAULT 60,
  min_liquidity_usd REAL DEFAULT 5000,   -- 2.4 节：门槛用 liquidity_total
  ath_sustain_candles INTEGER DEFAULT 3, -- 2.2 节的 k
  cooldown_minutes INTEGER DEFAULT 30,
  bounce_pct   REAL DEFAULT 25,         -- type='bounce' 时使用
  channels     TEXT,                    -- JSON: ["telegram:critical","webpush"]
  enabled      INTEGER DEFAULT 1
);

CREATE TABLE alert_states (
  token_id  TEXT NOT NULL,
  rule_id   TEXT NOT NULL,
  level     REAL NOT NULL,
  state     TEXT NOT NULL,              -- 'ARMED' | 'FIRED'
  hit_count INTEGER DEFAULT 0,
  local_low REAL,                       -- FIRED 后追踪的局部低点，供 bounce 规则用
  local_low_ts INTEGER,
  last_fired_at INTEGER,
  PRIMARY KEY (token_id, rule_id, level)
);

CREATE TABLE alerts (
  id         TEXT PRIMARY KEY,
  token_id   TEXT NOT NULL,
  rule_id    TEXT,
  type       TEXT,                      -- 'drawdown' | 'bounce'
  level      REAL,
  fired_at   INTEGER NOT NULL,
  price_usd  REAL,
  ath_usd    REAL,
  drawdown_usd REAL,
  drawdown_native REAL,
  snapshot   TEXT,                      -- JSON: 2.5 节的全量指标
  verdict    TEXT,                      -- 'pullback' | 'unclear' | 'rug'
  delivered  TEXT,                      -- JSON: 各渠道投递结果
  acked_at   INTEGER
);
```

**规模估算**：100 代币 × 5m × 120 天 = 约 350 万行，SQLite 完全够用（建好 `(token_id, timeframe, ts)` 主键索引）。5m 超过 120 天聚合成 1h 后删除；1h 永久保留。每天自动备份 DB 文件到 `./backups/`。

---

## 7. 回撤引擎（核心逻辑伪代码）

```ts
async function processQuote(token: Token, quote: TokenQuote) {
  // 1. 写入/更新当前 5m candle
  upsertCandle(token.id, '5m', quote);

  // 2. 更新各模式 ATH
  for (const mode of ['rolling_90d', 'all_time', 'since_added']) {
    for (const qm of ['usd', 'native']) {
      updateAth(token.id, mode, qm, quote);   // rolling 模式用单调队列 O(1)
    }
  }

  // 3. 逐规则评估
  for (const rule of getRulesFor(token.id)) {
    const ath = getAth(token.id, rule.ath_mode, rule.quote_mode);
    if (!ath?.ath_robust) continue;

    const price = rule.quote_mode === 'usd' ? quote.priceUsd : quote.priceNative;
    const drawdown = (ath.ath_robust - price) / ath.ath_robust * 100;

    for (const level of JSON.parse(rule.levels)) {
      const st = getAlertState(token.id, rule.id, level);

      if (st.state === 'ARMED') {
        const liqOk = quote.liquidityUsd >= rule.min_liquidity_usd;
        if (drawdown >= level && liqOk) {
          st.hit_count++;
          if (st.hit_count >= rule.confirm_ticks && !inCooldown(token.id, rule)) {
            const snapshot = await buildSnapshot(token, quote, ath);
            fireAlert({ token, rule, level, drawdown, quote, ath, snapshot });
            st.state = 'FIRED';
            st.last_fired_at = now();
            st.local_low = price;
            st.local_low_ts = now();
          }
        } else {
          st.hit_count = 0;
        }
      } else if (st.state === 'FIRED') {
        // 追踪局部低点（供 bounce 规则）
        if (price < st.local_low) { st.local_low = price; st.local_low_ts = now(); }
        // 重新武装
        if (drawdown <= level - rule.hysteresis
            && sustainedFor(token.id, level, rule.rearm_minutes)) {
          st.state = 'ARMED';
          st.hit_count = 0;
        }
      }
      saveAlertState(st);
    }
  }
}
```

**关键实现要求**：
- **价格一律用 `decimal.js` 或字符串定点数**。Memecoin 价格常在 1e-12 量级，`number` 的浮点误差会让回撤计算在小数位失真。
- `updateAth` 里 `ath_robust` 必须回看历史 candle 判定（见 2.2），不能只看当前 tick。
- 每次 ATH 更新同步记录 `ath_liquidity`，事后无法补算。
- `rolling_90d` 的窗口最大值**不持久化缓存**。`ath_state.window_deque` 已删除——启动时从 `candles` 表重算即可，持久化的队列状态只带来失效风险（进程崩溃 / 回填补数据 / 手工改库都会让它与 candles 不一致，且不可检测）。
- ATH candle 改变时必须整组重算 `ath_liquidity` / `vol_h1_at_ath` / `ath_confidence` / `verdict_basis`（见 §2.2）。

---

## 8. 通知层

### 8.1 Telegram

- Bot API，webhook 模式（配合 Cloudflare Tunnel）而非 long polling
- **多频道路由**：不同 verdict 推送到不同 chat_id / topic，便于给不同严重级别配不同提示音
  - `telegram:critical` — 🟢 可能是回调（值得立刻看）
  - `telegram:normal` — 🟡 需要人工判断
  - `telegram:muted` — 🔴 疑似 rug（存档用，静音）
- 配置 `TELEGRAM_CHANNELS` 为 JSON map：`{"critical":"-100xxx","normal":"-100yyy","muted":"-100zzz"}`

**消息模板**：

```
🟢 $PEPE 回撤 -82.4%  (ETH)

价格   $0.00000412  ←  ATH $0.00002341
USD 回撤      -82.4%
ETH 计价回撤   -71.2%
高点时间   3 天前 (2026-08-21 14:20 UTC)  [90d 窗口]

流动性   $184k  (高点时 $312k, 保留 59%)
1h 成交   142 笔 (买 89 / 卖 53)
24h 量   $1.2M
持有人   4,821 (24h: -3.1%)

判断依据: 流动性保留 59%、双向成交活跃、距高点 3 天
⚠️ 该币历史有插针 (raw ATH 比 robust ATH 高 41%)
📝 备注: 之前筛出来的 pons 生态相关

[DexScreener] [GMGN] [Explorer] [已读] [静音24h]
```

`📝 备注` 直接取 `tokens.note`——你加币时写的筛选理由，报警时最需要回忆的就是这个。

### 8.2 Web Push
PWA + Service Worker + VAPID，用于移动端锁屏推送，与 Telegram 互为冗余。

### 8.3 投递保证
- 每条 alert 的投递结果写入 `alerts.delivered`
- 失败重试 3 次（指数退避），仍失败则 UI 顶部横幅提示
- Worker 启动时补发未投递的 alert，但**超过 2 小时的不补**——过期的抄底信号没有价值

---

## 9. Web 界面

### 9.1 主看板（`/`）
表格 + 卡片双视图（移动端默认卡片）：

| 列 | 说明 |
|---|---|
| 代币 | symbol + 链图标 + 备注（hover 展开） |
| 当前价 | USD，带 5m 变化 |
| ATH | robust 值 + 时间距今 + 当前模式标识 |
| **回撤** | 百分比，颜色梯度（0~50 灰 / 50~80 黄 / >80 红），**默认按此列降序** |
| 距下一档 | 「还差 6.2pp 到 85%」 |
| 流动性 | 当前 + 相对 ATH 时的比例 |
| 24h 量 | |
| 迷你走势 | 90 天 sparkline |
| 状态 | ARMED / FIRED / FROZEN 徽章 |

顶部筛选：链、tag、状态、回撤区间。
顶部指标条：清单总数、FIRED 数量、数据源健康、上次轮询时间。

### 9.2 代币详情（`/token/[id]`）
- lightweight-charts K 线，叠加 ATH 水平线 + 各档位阈值线 + 历史报警标记
- 三种 ATH 模式切换、USD/原生计价切换
- 该代币的规则覆盖设置
- 报警历史
- 池子列表（哪个是 primary、各自流动性）

### 9.3 报警历史（`/alerts`）
时间倒序，可筛选。每条可展开看当时的完整 snapshot——这是复盘「阈值设得对不对」的唯一依据。

### 9.4 添加代币（`/add`）
- 粘贴地址自动识别链（Solana base58 vs EVM 0x；EVM 需要选链或全链探测）
- 批量粘贴，一行一个，支持 `chain:address` 或纯地址
- 支持粘贴 DexScreener / GMGN / GeckoTerminal URL 自动解析
- **必填 note 字段**——强制记录筛选理由
- 添加后立即触发 OHLCV 回填，UI 显示进度

### 9.5 设置（`/settings`）
全局默认规则、Telegram 频道映射、数据源开关、轮询间隔、数据保留策略。

### 9.6 移动端
PWA manifest 可加桌面；响应式，窄屏切卡片流；Web Push 通知。

---

## 10. API

```
GET    /api/tokens                  # 列表，支持筛选/排序
POST   /api/tokens                  # 添加（单个或批量）
PATCH  /api/tokens/:id              # 改备注/tag/enabled/frozen
DELETE /api/tokens/:id

GET    /api/tokens/:id/candles      # ?timeframe=5m&from=&to=
GET    /api/tokens/:id/ath
POST   /api/tokens/:id/backfill     # 手动触发历史回填

GET    /api/rules
POST   /api/rules                   # 创建单代币覆盖规则
PUT    /api/rules/:id

GET    /api/alerts                  # ?verdict=&from=&limit=
POST   /api/alerts/:id/ack

GET    /api/health                  # 数据源状态、上次轮询、失联代币数
GET    /api/stream                  # SSE：实时价格与报警推送
```

**鉴权**：单用户工具，一个长随机 `ACCESS_TOKEN`（env 配置）做 Bearer / Cookie 校验即可，不要实现用户系统。生产环境再套一层 Cloudflare Access。

---

## 11. 部署与网络

**形态**：docker-compose 两个 service（`web` + `worker`）共享 volume 挂载 SQLite。

**网络注意事项（重要）**：
- DexScreener、GeckoTerminal、Telegram API 从中国大陆直连均不可靠 → **必须部署在境外 VPS**（香港/新加坡/日本延迟最低）
- Worker 支持 `HTTPS_PROXY` 环境变量，便于本地开发时走本地代理调试
- Web UI 访问推荐用 Cloudflare Tunnel 暴露，同时解决多设备访问、HTTPS 证书、不暴露 VPS IP 三个问题
- Telegram Bot 用 webhook 模式（走 Cloudflare Tunnel），比 long polling 更稳更省流量

**密钥管理**：
- 所有密钥（`TELEGRAM_BOT_TOKEN`、RPC endpoint、`COINGECKO_API_KEY`、`ACCESS_TOKEN`、VAPID keys）只走 `.env`
- `.env` 加入 `.gitignore`，仓库放 `.env.example` 占位符
- 日志输出、报错堆栈、前端响应中不得包含完整密钥，需掩码（保留前 4 后 4）
- **Claude Code 在实现和调试过程中若需展示配置，一律输出掩码值**

---

## 12. 配置文件

```jsonc
// config.default.json
{
  "chains": {
    "ethereum": { "dexscreenerId": "ethereum", "geckoId": "eth",       "rpc": "$ETH_RPC" },
    "base":     { "dexscreenerId": "base",     "geckoId": "base",      "rpc": "$BASE_RPC" },
    "bsc":      { "dexscreenerId": "bsc",      "geckoId": "bsc",       "rpc": "$BSC_RPC" },
    "solana":   { "dexscreenerId": "solana",   "geckoId": "solana",    "rpc": "$SOL_RPC" },
    "robinhood":{ "dexscreenerId": "robinhood","geckoId": "robinhood", "rpc": "https://rpc.mainnet.chain.robinhood.com",
                  "evmChainId": 4663, "preferredSource": "geckoterminal" }
  },
  "defaultRule": {
    "athMode": "rolling_90d",
    "quoteMode": "usd",
    "levels": [80, 85, 90, 95],
    "confirmTicks": 2,
    "hysteresis": 15,
    "rearmMinutes": 60,
    "minLiquidityUsd": 5000,
    "athSustainCandles": 3,
    "cooldownMinutes": 30
  },
  "polling": {
    "intervalSeconds": 30,
    "frozenIntervalSeconds": 21600,
    "staleMinutes": 15
  },
  "retention": { "candles5mDays": 120, "candles1hDays": null }
}
```

---

## 13. 实施阶段

**Phase 0 — 数据源验证（先做，10 分钟）**
0. 跑 4.2 节的两条 curl，确认 Robinhood Chain 在 GT / DexScreener 的可用性，把结果回填到 config

**Phase 1 — 最小闭环**
1. SQLite schema + Drizzle
2. DexScreener 适配器（eth/base/bsc/solana）+ GeckoTerminal 适配器（robinhood）
3. 30 秒全量轮询
4. `since_added` 模式 ATH（不需要回填，可先跑起来）
5. 单档位 80% 回撤 + 状态机 + 去重
6. Telegram 单频道推送
7. 极简 Web 列表页

*验收：加 5 个代币（含 1 个 Robinhood Chain 的），能正确报警一次且不重复刷屏。*

**Phase 2 — 数据准确性**
8. GeckoTerminal OHLCV 回填 → `rolling_90d` + `all_time`（单调队列实现）
9. `ath_robust` 插针过滤
10. 原生币计价
11. 多池管理 + primary pool 选举
12. 失联检测

*验收：人工比对 10 个代币的 90 天最高价与 DexScreener 网页显示，误差 < 5%；插针币的 raw/robust 差异能正确识别出来。*

**Phase 3 — 多档位与详情页（已完成）**
13. 多档位阶梯 `[80, 85, 90, 95]`，每档独立触发一次
14. 代币详情页：K 线（lightweight-charts）+ ATH 水平线 + 各档阈值线 + 历史报警标记
15. 三种 ATH 模式切换、USD/原生币计价切换、池子列表、报警历史

---

## 已砍掉的范围（v1 不做）

以下属于**决策辅助**而非价格跟踪，v1 明确不实现：

- **抄底可行性快照 + 🟢🟡🔴 verdict 分类**（原 §2.5 的分档标签）。
  报警消息已带流动性保留率、1h 买卖笔数、24h 量、主池占比等原始指标，
  足够人工判断；启发式标签的价值不足以支撑其复杂度。
  §2.5 中 `verdict_basis` / `vol_h1_at_ath` 的计算已实现并存库，
  日后若要加分类，数据是现成的。
- **反弹确认报警**（`bounce` 规则）。`alert_rules.type`、`alert_states.local_low`
  等字段已预留并在维护，日后可直接用。
- **多频道路由**（按 verdict 推不同 Telegram 频道）。Phase 1 的单频道够用。
- **PWA + Web Push**、Telegram inline keyboard 交互。

> 砍掉的理由：这是个人价格跟踪工具，运维与理解成本比功能完备重要。
> 缺了再加，比先堆上再拆容易。

## 附录 A：链上直读价格（仅在数据源失效时需要）

保留备查，v1 不实现。

- **Uniswap V2 类**：读 `getReserves()`
- **Uniswap V3 类**：读 `slot0().sqrtPriceX96`
- **Uniswap V4（Robinhood Chain / pons v2）**：通过 `StateView.getSlot0(poolId)` 读取。`poolId` = PoolKey 的 keccak256。注意 memeHook 池的 `poolFee = 0`，费用在 hook 内收取，**不影响读价**
- **Solana**：Jupiter Price API 或直读 Raydium / Meteora 池账户

统一乘以原生币 USD 价（单独维护 ETH/BNB/SOL 报价，CoinGecko `simple/price`，60s 刷新）。
