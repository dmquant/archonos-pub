#!/usr/bin/env bash
# ArchonOS One-Command Autonomous Installer & Initializer
# Usage: ./scripts/install.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "======================================================================"
echo "🚀 ArchonOS Autonomous Installer & Initializer"
echo "======================================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Error: Node.js (>=20) is required. Please install Node.js first."
  exit 1
fi

echo "1️⃣  Running autonomous CLI Hands, Headless Mode, MCP & Skills discovery..."
node scripts/archon-init.mjs

echo "2️⃣  Running verification suites..."
npm run test:registry
npm run test:canvas
npm run test:worker
npm run test:app
npm run test:cli

echo ""
echo "✅ ArchonOS is initialized and ready!"
echo "👉 Start the sovereign workbench server:"
echo "   npm start"
echo "👉 Then open: http://127.0.0.1:8790"
echo "======================================================================"
