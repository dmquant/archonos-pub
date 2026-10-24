# ArchonOS — 配置说明与可视化管理手册

**[English](../en/CONFIGURATION.md) | [简体中文](./CONFIGURATION.md)** • **[返回总览 README](../../README.zh-CN.md)**

---

## 1. 可移植工作区配置文件 (`.archon/config.json`)

ArchonOS 将所有与本机环境相关的运行时配置保存在 `.archon/config.json` 中（该目录已加入 `.gitignore`，确保您的本地设置绝不会泄露到公共 Git 仓库）。当新用户克隆仓库并运行 `npm run init`（或 `./scripts/install.sh`）时，系统会基于模板 [`config/archon.defaults.json`](../../config/archon.defaults.json) 自动探测本机环境并生成 `.archon/config.json`。

### `.archon/config.json` 配置示例

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

## 2. 本地 CLI 执行手管理与无头模式配置 (`⚙️ 本地执行手`)

在 Web 工作台（`http://127.0.0.1:8790`）的 **⚙️ 本地执行手** 视图中：
1. **⚡ 一键自动初始化与重新扫描 (`1-Click Autonomous Initialize & Re-Scan`)**：自动重新扫描本机安装的 `claude`、`codex`、`agy`、`opencode` 二进制文件与本地 MCP 服务，并更新 `.archon/config.json`。
2. **🛠️ 模型执行手无头模式配置器 (`Model Hand Headless Mode Configurator`)**：
   - 选择任意 CLI 引擎（`claude`、`codex`、`agy`、`opencode`），或直接点击上方表格中的 **⚙️ Configure** 按钮。
   - 设置**二进制路径**为 `auto`（自动动态探测）或指定路径（如 `~/.local/bin/codex`）。
   - 自定义**无头参数模板**（使用 `{{prompt}}` 作为提示词注入占位符）与**超时阈值 (ms)**。
   - 点击 **💾 Save Headless Profile** 即可实时保存至 `.archon/config.json` 并立即生效。
3. **📄 可移植工作区配置编辑器**：支持在网页端直接编辑 `.archon/config.json` 全量 JSON 并一键保存。

---

## 3. 外部 MCP 服务与细粒度权限管理 (`🔌 外部 MCP`)

在 **🔌 外部 MCP** 视图中：
1. **🔍 自动发现本地 MCP (`Auto-Discover Local MCPs`)**：自动扫描本机 `~/.gemini/antigravity/mcp`、`~/.cursor/mcp.json`、`~/.claude/claude_desktop_config.json` 与 `.archon/mcp.json`，并将发现的服务以不透明句柄 `secret://mcp/<id>` 自动接入。
2. **+ 添加/配置自定义外部 MCP 服务**：
   - 支持注册任意 `stdio-bridge`（本地进程桥接）或 `https`（远程端点）MCP 服务，填写 `secret://...` 密钥句柄与工具列表。
   - 支持一键切换 **Enable / Disable** 状态，或点击 **Delete** 删除自定义 MCP 服务。
3. **🛡️ 按席位授权与一键撤销 MCP 工具**：
   - 选择席位（`seat:<id>`）、MCP 服务与工具名，点击 **+ 授权 MCP 工具权限**。
   - 点击 **⚡ Grant All Server Tools to Seat** 可将该 MCP 服务下的全部工具一键批量授权给当前席位。
   - 在下方已生效授权列表中，点击任意条目右侧的 **✗ Revoke** 即可立即撤销授权，恢复 `403 Default-Deny` 拦截状态。
4. **⚡ 受控 MCP 实时工具调用演练场**：
   - 任选调用席位、目标 MCP 服务与工具，点击 **▶ Execute Governed MCP Call** 即可实时对比“已授权放行（`ALLOW`）”与“未授权默认拒绝（`403 DEFAULT-DENY`）”的真实返回。

---

## 4. Harness2 RSI 技能全生命周期管理 (`🧬 RSI 与技能`)

在 **🧬 RSI 与技能** 视图中：
- **⚡ 实时 Harness2 RSI 技能蒸馏**：调用本地 `claude`、`codex` 或 `agy` CLI 从工作区轨迹自动合成 `SKILL.md` 并执行 $k = 3$ 留出集回放门控验证。
- **⚡ 快速创建并激活（操作员模式 `Quick Create & Activate`）**：由操作员直接编写或粘贴 `SKILL.md`，一键完成创建与交互式授权激活，立即注入对应席位的 CLI 系统提示词中。
- **✏️ 编辑 / 🗑️ 删除 / 禁用**：点击技能列表中的 **✏️ Edit** 可将该技能加载至编辑器并自动递增版本号，支持随时 **Disable** 停用或 **🗑️** 删除技能。

---

## 5. 执政官席位可视化管理 (`🪑 席位配置`)

在 **🪑 席位配置** 视图中：
- 点击任意席位卡片即可加载至右侧表单，自由修改**席位显示名称**、**默认绑定的本地 CLI 执行手**（`claude`、`codex`、`agy`、`opencode`）以及**系统角色提示词（System Prompt）**。
- 支持随时新增专职席位、一键切换启用/禁用或删除自定义席位。
