#!/bin/bash
set -e

echo "=== Elsa 反安裝腳本 ==="

# 停止 daemon
echo "停止 elsa daemon..."
elsa stop 2>/dev/null || true

# 移除系統服務
echo "移除 systemd 服務..."
elsa uninstall-service 2>/dev/null || true

# 移除全域套件
echo "移除 elsa 套件..."
npm uninstall -g elsa

# 詢問是否刪除設定檔
read -p "是否刪除設定檔 ~/.elsa/？(y/N): " answer
if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
  rm -rf ~/.elsa
  echo "已刪除 ~/.elsa/"
else
  echo "保留 ~/.elsa/（內含 bot token 等設定）"
fi

echo ""
echo "=== 反安裝完成 ==="
