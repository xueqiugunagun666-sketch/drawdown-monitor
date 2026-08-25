# 部署到服务器

面向 Ubuntu 22.04 / 24.04，**地域必须在境外**（新加坡 / 东京 / 香港等）。
国内地域连不上 DexScreener、GeckoTerminal、Telegram，装完也拉不到数据。

## 为什么不用 Docker

规格 §11 原本写的是 docker-compose。实际部署在 2GB 内存的机器上，
Docker 守护进程本身要占约 100MB，构建时还要额外内存，而且对不熟运维的人
多了一层会坏的地方。systemd 直接跑更省内存，日志用 `journalctl` 看，
崩了自动重启 —— 符合规格里「运维成本比架构优雅重要」这条。

## 一条命令

```bash
git clone <你的仓库> /tmp/drawdown && cd /tmp/drawdown && sudo bash deploy/install.sh
```

脚本会依次做这些事，**幂等**，重复执行不会破坏已有数据：

1. **网络自检** —— 三个数据源都要通，不通直接中止（避免装完才发现地域选错）
2. 内存不足 3GB 时创建 2GB swap（`next build` 是内存大户）
3. 安装 Node 22、Caddy、sqlite3
4. 创建 `drawdown` 系统用户，代码放 `/opt/drawdown-monitor`
5. 交互式填写 Telegram token、chat id、网页登录口令（留空则自动生成强口令）
6. 询问访问域名
7. `npm ci` + `npm run build` + 建表
8. 装好并启动 systemd 服务与每日备份定时器

## 没有域名怎么办

去 <https://www.duckdns.org> 用 GitHub 登录，免费建一个子域名，
把 IP 填成服务器公网 IP，然后在脚本提示时填 `你的名字.duckdns.org`。

Caddy 会自动申请并续期 Let's Encrypt 证书，效果和自有域名一样。

> 境外地域**不需要 ICP 备案**。

## 日常操作

```bash
# 看 worker 日志（报警、回填、错误都在这里）
journalctl -u drawdown-worker -f

# 看网页日志
journalctl -u drawdown-web -f

# 重启
systemctl restart drawdown-worker drawdown-web

# 更新代码
cd /opt/drawdown-monitor && git pull \
  && sudo -u drawdown npm ci && sudo -u drawdown npm run build \
  && systemctl restart drawdown-worker drawdown-web

# 立即备份一次
systemctl start drawdown-backup

# 查看备份（每天一次，保留 7 天，gzip 压缩）
ls -lh /opt/drawdown-monitor/backups
```

## 恢复备份

```bash
systemctl stop drawdown-worker drawdown-web
cd /opt/drawdown-monitor
gunzip -c backups/monitor-20260825-030000.db.gz > data/monitor.db
chown drawdown:drawdown data/monitor.db
systemctl start drawdown-worker drawdown-web
```

## 端口与防火墙

只需放通 **80** 和 **443**（Caddy 用）。应用本身监听 `127.0.0.1:3000`，
不对外暴露。腾讯云轻量在控制台的「防火墙」里放通这两个端口。

**不要**放通 3000 —— 那会绕过 HTTPS 和登录中间件之外的一层保护。

## 安全须知

- 网页有登录口令（`ACCESS_TOKEN`），登录失败按 IP 限流：10 分钟 8 次
- cookie 是 httpOnly + SameSite=Lax，30 天有效
- `.env` 权限 600，只有 `drawdown` 用户可读
- **共用清单意味着知道口令的人都能加币删币**，且不记录是谁操作的。
  只把口令给信得过的人。
