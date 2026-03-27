#!/bin/bash
set -e

echo "=== Elsa 安裝腳本 ==="

# 檢查 Node.js 版本
if ! command -v node &> /dev/null; then
  echo "錯誤：未安裝 Node.js（需要 >= 18）"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "錯誤：Node.js 版本過低（目前 $(node -v)，需要 >= 18）"
  exit 1
fi
echo "Node.js $(node -v) OK"

# 檢查 claude CLI
if ! command -v claude &> /dev/null; then
  echo "錯誤：未安裝 claude CLI（npm install -g @anthropic-ai/claude-code）"
  exit 1
fi
echo "Claude CLI OK"

# 安裝本地專案的 elsa
echo "安裝 elsa（從本地專案目錄）..."
cd "$(dirname "$0")"
npm install
chmod +x node_modules/.bin/tsc
rm -rf dist
npx tsc
chmod +x dist/cli.js
npm install -g . --ignore-scripts

# 安裝系統服務（systemd）
echo "安裝 systemd 服務..."
elsa install-service

echo ""
echo "=== 安裝完成 ==="
echo "執行 elsa setup 進行初始設定"
echo "執行 elsa start 啟動服務"
