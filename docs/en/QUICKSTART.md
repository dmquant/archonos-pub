# ArchonOS — Autonomous Installation & Quickstart Guide

**[English](./QUICKSTART.md) | [简体中文](../zh-CN/QUICKSTART.md)** • **[Back to README](../../README.md)**

---

## 1. Prerequisites

- **Node.js** `>= 20.0.0`
- **Python 3** `>= 3.10` (used by `archon-ledger` and `archon-hands` verification suites)
- *(Optional)* One or more local AI CLI engines installed on your machine:
  - **Claude Code CLI** (`claude`)
  - **OpenAI Codex CLI** (`codex`)
  - **Antigravity CLI** (`agy`)
  - **OpenCode CLI** (`opencode`)

> **Note:** Even if no CLI binaries are installed yet, ArchonOS boots cleanly and provides deterministic governed synthesis fallbacks so you can explore all 6 views, MCP playgrounds, Harness2 RSI skill gates, and 3D/2D Canvas Artifacts immediately.

---

## 2. One-Command Autonomous Install & Initialization

Clone the repository and run the autonomous installer script:

```bash
git clone https://github.com/your-org/archon-os.git
cd archon-os
./scripts/install.sh
```

### What `npm run init` (`scripts/archon-init.mjs`) Does Automatically

1. **Creates Portable Runtime Directories**:
   - `.archon/` (git-ignored local runtime state)
   - `.archon/artifacts/` (local JSON data stores for Canvas Artifacts)
   - `.archon/skills/` (workspace `SKILL.md` bundles)
   - `packages/archon-app/public/artifacts/` (rendered HTML dashboards)
2. **Probes Local Headless CLI Hands**:
   - Scans `$PATH`, `~/.local/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` for `claude`, `codex`, `agy`, and `opencode`.
   - Masks your home directory as `~` so personal filesystem paths are never leaked to the UI or config files.
   - Configures each CLI engine's non-interactive headless arguments and circuit-breaker timeouts in `.archon/config.json`:
     - `claude`: `claude -p "{{prompt}}" --output-format stream-json --verbose`
     - `codex`: `codex exec "{{prompt}}" --skip-git-repo-check`
     - `agy`: `agy chat --mode agent --print "{{prompt}}"`
     - `opencode`: `opencode run "{{prompt}}"`
3. **Auto-Discovers Local MCP Servers**:
   - Scans `~/.gemini/antigravity/mcp`, `~/.cursor/mcp.json`, and `~/.claude/claude_desktop_config.json` (plus optional `.archon/mcp.json`).
   - Registers discovered MCP servers with opaque `secret://mcp/<server-id>` handles (never copying plaintext tokens).
4. **Seeds Starter Skills & Artifacts**:
   - Initializes starter `SKILL.md` files and baseline Canvas Artifact JSON datasets if none exist yet.

---

## 3. Starting the Workbench & CLI Commands

```bash
# Start the local ArchonOS Workbench on http://127.0.0.1:8790
npm start

# Re-run autonomous initialization at any time (keep existing custom overrides)
npm run init

# Force reset .archon/config.json to fresh auto-discovered defaults
npm run init:force

# Or use the archon CLI directly:
npx archon init
npx archon hands probe
npx archon status
```

Open **`http://127.0.0.1:8790`** in your browser to access the 6-view workbench:
1. **💬 Chat & Canvas**: Split-screen multi-seat chat with live Markdown/Mermaid rendering and interactive 3D/2D Canvas Artifacts.
2. **🪑 Archon Seats**: Add, edit, enable/disable, or delete seats and assign their default CLI hand.
3. **🔌 External MCPs**: Auto-discover local MCPs, add custom MCP servers, manage per-seat tool grants, and test `ALLOW` vs `403 DEFAULT-DENY`.
4. **⚙️ Local Hands**: Trigger 1-click Web Autonomous Init, inspect rolling latency & circuit-breaker state, and customize headless CLI flags.
5. **🧬 RSI & Skills**: Run the 10-Round RSI Loop (`R1 → R10`), synthesize skills via CLI hands, or quick-create & activate operator skills.
6. **📦 Artifacts**: Inspect portable workspace paths, edit artifact JSON datasets live, and view SHA-256 revision diffs.
