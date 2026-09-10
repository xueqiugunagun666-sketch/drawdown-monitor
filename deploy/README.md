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
git clone <repository-url> /tmp/show-tools && cd /tmp/show-tools && sudo bash deploy/install.sh
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

# 立即强制备份一次（定时服务在非 04 点会主动跳过）
sudo -u drawdown /opt/drawdown-monitor/deploy/backup.sh --force

# 查看备份（每天低峰一次，保留 14 天，快速 gzip 压缩）
ls -lh /opt/drawdown-monitor/backups
```

## 更新代码

`/opt/drawdown-monitor` **不是 git 仓库**（`install.sh` 是从 /tmp 的克隆拷过去的），
所以这里 `git pull` 不管用。实际流程是从本机 rsync 到 `~/deploy-stage` 再进 `/opt`：

```bash
# 本机：先干跑，确认只有预期的文件会变
rsync -avn --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude 'data' \
  --exclude 'backups' --exclude 'backups-remote' --exclude '.env' \
  --exclude 'tsconfig.tsbuildinfo' --exclude '.DS_Store' \
  ./ <ssh-host>:deploy-stage/
# 去掉 -n 实跑
```

```bash
# 服务器：强制备份 -> 同步 -> 迁移 -> 构建 -> 重启
sudo -u drawdown /opt/drawdown-monitor/deploy/backup.sh --force
sudo rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude 'data' --exclude 'backups' --exclude 'backups-remote' --exclude '.env' \
  --exclude 'tsconfig.tsbuildinfo' ~/deploy-stage/ /opt/drawdown-monitor/
sudo chown -R drawdown:drawdown /opt/drawdown-monitor/src /opt/drawdown-monitor/scripts
cd /opt/drawdown-monitor
sudo -u drawdown npm run db:migrate      # 见下方说明，这一步不能省
sudo -u drawdown npm run build
sudo systemctl restart drawdown-web drawdown-worker
```

**为什么要单独跑 `db:migrate`**：`next start` 不执行迁移，只有 worker 启动时会跑
（`src/worker/worker.ts`）。两个服务重启谁先谁后没有保证，web 先起来就会 500 报
`no such column`。迁移是幂等的，多跑无害。

**只改了前端时**可以只重启 `drawdown-web`，省得中断轮询；但凡碰了 `src/db/` 或
`src/worker/` 就两个都要重启。

## 权限

删除、改备注、停用/冻结、改报警档位需要**管理员**。管理员由 `.env` 里的
`ADMIN_ACCOUNT` 指定，值是**账号名**（`users.name`），不是 uuid。多个用逗号分隔：

```
ADMIN_ACCOUNT=<admin-a>,<admin-b>
```

每一项都是**整体相等**匹配，不做前缀或包含匹配。例如配置 `admin-a` 不会把
`admin-a-test` 一起提权。

**不设或设错 = 没有人是管理员**，所有删除都会被拒（fail closed）。这是有意的 ——
反过来默认人人可删的话，配置一丢就等于把删除权限敞开给所有人。

改完要重启网页服务：

```bash
sudo systemctl restart drawdown-web
```

查看谁删过什么、改过什么备注：

```bash
cd /opt/drawdown-monitor && sudo -u drawdown npm run audit        # 默认最近 30 条
cd /opt/drawdown-monitor && sudo -u drawdown npm run audit -- 100
```

审计记录与被审计的操作在**同一个事务**里写入 —— 日志写不进去，操作也会回滚。
删除还会额外推一条 Telegram，那条是尽力而为的，推失败不影响删除本身。

## 恢复备份

```bash
systemctl stop drawdown-worker drawdown-web
cd /opt/drawdown-monitor
gunzip -c backups/monitor-20260825-030000.db.gz > data/monitor.db
chown drawdown:drawdown data/monitor.db
systemctl start drawdown-worker drawdown-web
```

## Caddy 起不来时

```bash
systemctl status caddy --no-pager -l
caddy validate --config /etc/caddy/Caddyfile
journalctl -u caddy -n 50 --no-pager
```

常见原因：

| 现象 | 原因 | 处理 |
|---|---|---|
| `control process exited` | Caddyfile 语法错 | `caddy validate` 会指出具体行 |
| 证书签发一直失败 | 域名没解析到本机，或 80 端口没放通 | `getent hosts 你的域名` 对比 `curl https://api.ipify.org` |
| `address already in use` | 80/443 被别的服务占了 | `ss -lntp \| grep -E ':80\|:443'` |
| `permission denied` 打不开日志 | 日志文件属主是 root | 现在已改为写 journald，不该再出现；真遇到就 `rm -f /var/log/caddy/*.log` |

Caddy 的日志用 `journalctl -u caddy -f` 看，和另外两个服务一致。

DuckDNS 改完 IP 后解析生效通常要一两分钟，期间 Caddy 会签证书失败。
生效后执行 `systemctl restart caddy` 即可，不必重跑安装脚本。

## 端口与防火墙

只需放通 **80** 和 **443**（Caddy 用）。应用本身监听 `127.0.0.1:3000`，
不对外暴露。腾讯云轻量在控制台的「防火墙」里放通这两个端口。

**不要**放通 3000 —— 那会绕过 HTTPS 和登录中间件之外的一层保护。

## 安全须知

- 全站只使用个人账号会话；新人必须凭有次数上限的邀请码注册，不再使用共享进站口令。
  登录失败按 IP 限流：10 分钟 8 次
- cookie 是 httpOnly + SameSite=Lax，账号会话 30 天有效
- 密码用 scrypt 哈希，会话表里只存 token 的哈希 —— 库泄露也拿不到可用凭证
- `.env` 权限 600，只有 `drawdown` 用户可读
- 删除和修改按“管理员或资源所有者”规则控制；停用、冻结和全局报警档位等共享操作
  收归管理员。敏感操作与审计日志在同一事务中写入（`npm run audit`）。
- 中间件跑在 edge runtime，只能判断会话 Cookie 是否存在；每个 API 路由都会再查询
  数据库校验真实会话，只读接口也不例外。
