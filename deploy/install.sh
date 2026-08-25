#!/bin/bash
# 一次性部署脚本。在全新的 Ubuntu 22.04 / 24.04 上以 root 执行：
#
#   bash deploy/install.sh
#
# 幂等：重复执行不会破坏已有数据。
set -euo pipefail

APP_USER=drawdown
APP_DIR=/opt/drawdown-monitor
NODE_MAJOR=22

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "请用 root 执行：sudo bash deploy/install.sh"; exit 1; }

# ---------------------------------------------------------------- 网络自检
step "检查能否访问数据源（这一步失败说明地域选错了）"
# 判据是「拿到预期的 HTTP 状态码」，不是一律要 200：
#   Telegram 用 bot0:0/getMe，正常会返回 401（口令无效但 API 在响应）——
#   这比打根路径拿 302 更能说明 Bot API 那一层是通的。
#   真正不通时 curl 拿到的是 000。
check() {
  local name=$1 want=$2 url=$3 code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)
  if [ "$code" = "$want" ]; then grn "  $name  $code"; return 0; fi
  red "  $name  $code（期望 $want）"; return 1
}
FAILED=0
check "dexscreener  " 200 "https://api.dexscreener.com/token-pairs/v1/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" || FAILED=1
check "geckoterminal" 200 "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" || FAILED=1
check "telegram     " 401 "https://api.telegram.org/bot0:0/getMe" || FAILED=1
if [ "$FAILED" -ne 0 ]; then
  red ""
  red "有数据源不可达。这台机器不能用于本项目 —— 地域必须在境外（新加坡/东京等）。"
  red "国内地域（北京/上海/广州）连不上这些接口，装完也拉不到任何数据。"
  exit 1
fi

# ---------------------------------------------------------------- swap
step "检查内存与 swap"
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
echo "  内存 ${MEM_MB}MB，swap ${SWAP_MB}MB"
if [ "$MEM_MB" -lt 3000 ] && [ "$SWAP_MB" -lt 1000 ]; then
  ylw "  内存不足 3GB 且没有 swap —— next build 可能被 OOM 杀掉，创建 2GB swap"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  grn "  swap 已启用"
fi

# ---------------------------------------------------------------- 依赖
step "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git sqlite3 build-essential debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  step "安装 Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
grn "  node $(node -v) / npm $(npm -v)"

if ! command -v caddy >/dev/null; then
  step "安装 Caddy（负责 HTTPS）"
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
grn "  caddy $(caddy version | head -1)"

# ---------------------------------------------------------------- 用户与目录
step "创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
# 脚本可能从别处运行，把代码同步到 APP_DIR
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  echo "  从 $SRC_DIR 同步代码到 $APP_DIR"
  rsync -a --delete \
    --exclude node_modules --exclude .next --exclude data --exclude backups --exclude .env --exclude .git \
    "$SRC_DIR/" "$APP_DIR/"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# Caddy 日志走 journald，不建 /var/log/caddy —— 以 root 建目录/文件会导致
# caddy 用户写不进去，服务直接起不来

# ---------------------------------------------------------------- 配置
step "配置 .env"
if [ -f "$APP_DIR/.env" ]; then
  grn "  已存在 .env，保留不动（要改就直接编辑 $APP_DIR/.env）"
else
  read -rp "  Telegram Bot Token: " TG_TOKEN
  read -rp "  Telegram Chat ID:   " TG_CHAT
  read -rp "  网页登录口令（留空则自动生成一个强口令）: " WEB_PASS
  if [ -z "$WEB_PASS" ]; then
    WEB_PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
    ylw "  已生成登录口令：$WEB_PASS"
    ylw "  ^^^ 现在就记下来，之后不会再显示 ^^^"
  fi
  cat > "$APP_DIR/.env" <<ENVEOF
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT}
ACCESS_TOKEN=${WEB_PASS}
DATABASE_PATH=./data/monitor.db
COINGECKO_API_KEY=
ENVEOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

step "配置访问域名"
DOMAIN_FILE=/etc/drawdown-domain
if [ -f "$DOMAIN_FILE" ]; then
  DOMAIN=$(cat "$DOMAIN_FILE")
  grn "  已配置：$DOMAIN"
else
  echo "  没有域名的话，去 https://www.duckdns.org 免费注册一个（用 GitHub 登录即可），"
  echo "  建一个子域名并把 IP 填成本机公网 IP，然后在这里填 你的名字.duckdns.org"
  read -rp "  域名: " DOMAIN
  [ -n "$DOMAIN" ] || { red "  域名不能为空"; exit 1; }
  echo "$DOMAIN" > "$DOMAIN_FILE"
fi

# 证书签发走 HTTP-01，需要域名已解析到本机且 80 端口可达。
# 先自查，免得 Caddy 反复失败还不知道为什么。
step "检查域名解析"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
MYIP=$(curl -s --max-time 10 https://api.ipify.org || true)
echo "  $DOMAIN 解析到: ${RESOLVED:-（解析不到）}"
echo "  本机公网 IP:   ${MYIP:-（查不到）}"
if [ -z "$RESOLVED" ]; then
  ylw "  域名还解析不到 —— DuckDNS 那边可能刚改还没生效。"
  ylw "  可以继续装，但 Caddy 签证书会失败；解析生效后执行 systemctl restart caddy 即可。"
elif [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
  ylw "  解析地址与本机公网 IP 不一致 —— 证书会签发失败。"
  ylw "  去 DuckDNS 把 IP 改成 $MYIP，然后 systemctl restart caddy。"
fi

# ---------------------------------------------------------------- 构建
step "安装依赖并构建（这一步最慢，2GB 机器约 3-5 分钟）"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
sudo -u "$APP_USER" npm run db:migrate

# ---------------------------------------------------------------- 服务
step "安装 systemd 服务"
cp "$APP_DIR/deploy/drawdown-worker.service" /etc/systemd/system/
cp "$APP_DIR/deploy/drawdown-web.service"    /etc/systemd/system/
cp "$APP_DIR/deploy/drawdown-backup.service" /etc/systemd/system/
cp "$APP_DIR/deploy/drawdown-backup.timer"   /etc/systemd/system/
# 把域名直接替换进 Caddyfile，不依赖环境变量
sed "s|__DOMAIN__|${DOMAIN}|g" "$APP_DIR/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  red "  Caddyfile 校验未通过："
  caddy validate --config /etc/caddy/Caddyfile 2>&1 | sed 's/^/    /' | tail -20
  exit 1
fi
grn "  Caddyfile 校验通过"
systemctl daemon-reload
systemctl enable --now drawdown-worker drawdown-web drawdown-backup.timer >/dev/null
systemctl restart caddy

# ---------------------------------------------------------------- 收尾
step "等待服务就绪"
sleep 8
for s in drawdown-worker drawdown-web caddy; do
  if systemctl is-active --quiet "$s"; then grn "  $s  运行中"; else red "  $s  未运行 —— journalctl -u $s -n 50"; fi
done

echo
grn "部署完成"
echo
echo "  访问：https://${DOMAIN}"
echo "  登录口令在 ${APP_DIR}/.env 里的 ACCESS_TOKEN"
echo
echo "常用命令："
echo "  看日志      journalctl -u drawdown-worker -f"
echo "  重启        systemctl restart drawdown-worker drawdown-web"
echo "  更新代码    cd ${APP_DIR} && git pull && sudo -u ${APP_USER} npm ci && sudo -u ${APP_USER} npm run build && systemctl restart drawdown-worker drawdown-web"
echo "  手动备份    systemctl start drawdown-backup"
echo "  查看备份    ls -lh ${APP_DIR}/backups"
