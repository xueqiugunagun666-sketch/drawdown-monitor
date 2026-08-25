#!/bin/bash
# 双击即可启动（macOS）。首次使用如提示没有权限，先在终端里执行:
#   chmod +x start.command
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install || exit 1
fi

# 等服务起来后自动打开浏览器
( sleep 6; open "http://localhost:3000" ) &

npm start
