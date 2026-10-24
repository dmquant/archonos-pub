# ArchonOS — Configuration & Interactive Management Guide

**[English](./CONFIGURATION.md) | [简体中文](../zh-CN/CONFIGURATION.md)** • **[Back to README](../../README.md)**

---

## 1. Portable Workspace Configuration (`.archon/config.json`)

ArchonOS stores all host-specific runtime configuration in `.archon/config.json` (which is git-ignored so personal settings are never committed). When you clone the repository, `npm run init` (or `./scripts/install.sh`) generates `.archon/config.json` from [`config/archon.defaults.json`](../../config/archon.defaults.json).

### Example `.archon/config.json`

```json
{
  "schemaVersion": 1,
  "workspaceName": "archon-os",
  "defaultLanguage": "en",
  "server": {
    "host": "127.0.0.1",
    "port": 8790
  },
  "hands": {
    "defaultCwd": "/tmp",
    "timeoutMs": 28000,
    "engines": {
      "claude": {
        "enabled": true,
        "binaryPath": "auto",
        "headlessArgs": ["-p", "{{prompt}}", "--output-format", "stream-json", "--verbose"],
        "timeoutMs": 28000
      },
      "codex": {
        "enabled": true,
        "binaryPath": "auto",
        "headlessArgs": ["exec", "{{prompt}}", "--skip-git-repo-check"],
        "timeoutMs": 28000
      },
      "agy": {
        "enabled": true,
        "binaryPath": "auto",
        "headlessArgs": ["chat", "--mode", "agent", "--print", "{{prompt}}"],
        "timeoutMs": 22000
      }
    }
  }
}
```

---

## 2. Managing Local Model Hands (`⚙️ Local Hands`)

In the **⚙️ Local Hands** view of the Web Workbench (`http://127.0.0.1:8790`):
1. **⚡ 1-Click Autonomous Initialize & Re-Scan**: Scans your machine for `claude`, `codex`, `agy`, and `opencode`, discovers local MCP servers, and updates `.archon/config.json`.
2. **🛠️ Model Hand Headless Mode Configurator**:
   - Select any CLI engine (`claude`, `codex`, `agy`, `opencode`).
   - Set **Binary Path** to `auto` (dynamic `$PATH` / `~/.local/bin` discovery) or a custom path (`~/.local/bin/codex`).
   - Customize the **Headless Arguments Template** (using `{{prompt}}` where the user/seat prompt should be injected) and **Timeout (ms)**.
   - Click **💾 Save Headless Profile** to persist changes immediately to `.archon/config.json`.
3. **📄 Portable Workspace Config Editor**: Edit `.archon/config.json` directly in the browser and click **💾 Save Config JSON**.

---

## 3. Managing External MCP Servers & Grants (`🔌 External MCPs`)

In the **🔌 External MCPs** view:
1. **🔍 Auto-Discover Local MCPs**: Scans `~/.gemini/antigravity/mcp`, `~/.cursor/mcp.json`, `~/.claude/claude_desktop_config.json`, and `.archon/mcp.json` and registers discovered servers with opaque `secret://mcp/<id>` handles.
2. **+ Add / Configure External MCP Server**:
   - Register any custom `stdio-bridge` or `https` MCP server with an opaque `secret://...` handle and comma-separated tool catalog.
   - Toggle any server between **CONNECTED** and **DISABLED**, or **Delete** custom servers with one click.
3. **🛡️ Grant / Revoke MCP Tools per Seat**:
   - Authorize an individual `(seat:<id>, server, tool)` grant with **+ Authorize MCP Tool Grant (Interactive)**.
   - Click **⚡ Grant All Server Tools to Seat** to bulk-authorize all cataloged tools on a server for the selected seat.
   - Click **✗ Revoke** next to any active grant to immediately flip that tool back to `403 Default-Deny`.
4. **⚡ Governed MCP Live Tool Call Playground**:
   - Select any caller seat, target MCP server, and tool name, then click **▶ Execute Governed MCP Call** to verify live `ALLOW` telemetry vs `403 DEFAULT-DENY` policy enforcement.

---

## 4. Managing Harness2 RSI Skills (`🧬 RSI & Skills`)

In the **🧬 RSI & Skills** view:
- **⚡ Live Harness2 RSI Synthesis**: Spawn a local CLI hand (`claude`, `codex`, `agy`) to synthesize a new `SKILL.md` from workspace trajectories and automatically run the $k = 3$ held-out replay verifier.
- **⚡ Quick Create & Activate (Operator Mode)**: Author or edit a `SKILL.md` directly and activate it in one step with operator interactive authority (`origin = "interactive"`).
- **✏️ Edit / 🗑️ Delete / Disable**: Click **✏️ Edit** on any skill row to load its `SKILL.md` into the editor and bump its version, **Disable** active skills, or **🗑️** delete obsolete skills.

---

## 5. Managing Archon Seats (`🪑 Archon Seats`)

In the **🪑 Archon Seats** view:
- Create new seats or click any existing seat card (`chief-of-staff`, `code-architect`, `maritime-quant`, `ops-guardian`) to edit its **Display Name**, **Default CLI Hand** (`claude`, `codex`, `agy`, `opencode`), and **System Prompt**.
- Toggle seats enabled/disabled or delete custom seats at any time.
