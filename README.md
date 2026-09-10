# Show Tools

Show Tools 是一个只读的多链行情与钱包监控看板，覆盖回撤、钱包持仓、暴涨、
滚动新高、群聊信号和日程提醒。系统不包含交易、签名或下单能力。

当前主要能力：

- Ethereum、Base、BSC、Robinhood 与 Solana 的代币行情展示。
- EVM 与 Solana 钱包监控、地址备注、按用户隔离的持仓与小额资产阈值。
- 5m / 1h / 6h / 24h 暴涨报警，以及 3d / 7d / 30d / 90d / 180d / 360d / 全历史新高报警。
- 每个行情事件一条 Chrome 通知；提示音、SSE、后端心跳和报警读取均有显式故障提示。
- XXYY 15 秒钱包报警主报价；DexScreener 负责回撤看板、流动性、成交量与项目元数据。
- 邀请码注册、个人会话、多管理员权限与同事务审计日志。
- SQLite WAL 单机部署，Web 与 Worker 分进程运行。

完整架构、数据流、报警规则、数据库和安全边界见
[`docs/TECHNICAL_OVERVIEW.md`](./docs/TECHNICAL_OVERVIEW.md)。部署与恢复流程见
[`deploy/README.md`](./deploy/README.md)。

## 本机快速开始

```bash
npm install
cp .env.example .env
npm run db:migrate
npm start
```

默认访问地址是 <http://localhost:3000>。首次使用前需要在本地生成邀请码并注册账号。

```bash
npm run invite
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 同时启动 Worker 与 Web UI |
| `npm run worker` | 只启动 Worker |
| `npm run dev` | 只启动开发 Web UI |
| `npm run db:migrate` | 幂等执行数据库迁移 |
| `npm test` | 单元与集成测试 |
| `npm run typecheck` | TypeScript 静态检查 |
| `npm run check:sources` | 数据源冒烟检查，不写库 |
| `npm run audit` | 查看最近的权限操作审计记录 |

## 不可违反的约定

1. 所有价格和值运算使用 `decimal.js`；价格字段以十进制字符串存储。
2. 密钥只进入未跟踪的 `.env`，任何日志和报错统一按前 4 位、后 4 位掩码。
3. 不实现任何交易、签名或下单功能。
4. 静默失效比误报危险：空响应、报价缺失、投递失败和链路失活必须显式暴露。
