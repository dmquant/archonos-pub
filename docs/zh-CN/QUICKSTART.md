# ArchonOS — 全自动安装与快速上手指南

**[English](../en/QUICKSTART.md) | [简体中文](./QUICKSTART.md)** • **[返回总览 README](../../README.zh-CN.md)**

---

## 1. 环境准备

- **Node.js** `>= 20.0.0`
- **Python 3** `>= 3.10`（用于运行 `archon-ledger` 与 `archon-hands` 形式化验证套件）
- *（可选）* 本机安装任意一个或多个 AI CLI 命令行工具：
  - **Claude Code CLI** (`claude`)
  - **OpenAI Codex CLI** (`codex`)
  - **Antigravity CLI** (`agy`)
  - **OpenCode CLI** (`opencode`)

> **提示**：即便本机尚未安装任何 CLI 工具，ArchonOS 依然可以正常启动并提供确定性的受控回退合成响应，方便您立即体验全部 6 大工作台视图、MCP 权限演练场、Harness2 RSI 技能门控以及 3D/2D 交互式画布工件。

---

## 2. 一键全自动安装与初始化

克隆代码仓库并执行全自动安装脚本：

```bash
git clone https://github.com/your-org/archon-os.git
cd archon-os
./scripts/install.sh
```

### `npm run init` (`scripts/archon-init.mjs`) 自动完成了哪些工作？

1. **创建可移植的本地运行时目录**：
   - `.archon/`（默认加入 `.gitignore`，存放本地运行时状态与配置，绝不上传至公共仓库）
   - `.archon/artifacts/`（存放画布工件的结构化 JSON 数据集）
   - `.archon/skills/`（存放工作区 `SKILL.md` 技能包）
   - `packages/archon-app/public/artifacts/`（存放对话生成的交互式 HTML 看板文件）
2. **自动探测本地无头 CLI 执行手（Local Model Hands）**：
   - 自动扫描 `$PATH`、`~/.local/bin`、`~/.npm-global/bin`、`/opt/homebrew/bin` 与 `/usr/local/bin` 中的 `claude`、`codex`、`agy` 与 `opencode`。
   - 自动将用户主目录脱敏替换为 `~`，确保网页前端与配置文件中**绝不泄露任何个人机器路径**。
   - 自动为每个 CLI 写入最佳无头（Headless）调用模板、工作目录隔离（`cwd=/tmp`）与超时熔断参数至 `.archon/config.json`：
     - `claude`: `claude -p "{{prompt}}" --output-format stream-json --verbose`
     - `codex`: `codex exec "{{prompt}}" --skip-git-repo-check`
     - `agy`: `agy chat --mode agent --print "{{prompt}}"`
     - `opencode`: `opencode run "{{prompt}}"`
3. **自动发现并接入本机外部 MCP 服务**：
   - 自动扫描 `~/.gemini/antigravity/mcp`、`~/.cursor/mcp.json`、`~/.claude/claude_desktop_config.json` 及 `.archon/mcp.json`。
   - 将发现的 MCP 服务自动注册为仅含不透明句柄（`secret://mcp/<server-id>`）的受控连接器，零明文 Token 落盘。
4. **预置初始技能与基准画布工件**：
   - 自动生成开箱即用的 `SKILL.md` 技能模板与画布工件 JSON 数据集。

---

## 3. 启动工作台与常用命令

```bash
# 启动本地 ArchonOS 指挥官工作台（默认地址 http://127.0.0.1:8790）
npm start

# 随时重新运行主机扫描与配置初始化（保留已有自定义配置）
npm run init

# 强制重置 .archon/config.json 为最新自动探测默认配置
npm run init:force

# 或直接使用 archon CLI 命令：
npx archon init
npx archon hands probe
npx archon status
```

启动后在浏览器访问 **`http://127.0.0.1:8790`**，即可使用六大核心视图：
1. **💬 对话与画布**：左屏多席位流式对话（支持 Markdown 表格与 Mermaid 流程图渲染），右屏 3D/2D 交互式画布。
2. **🪑 席位配置**：新增、编辑、启用/禁用或删除专职席位，并配置默认 CLI 执行手。
3. **🔌 外部 MCP**：一键自动发现本地 MCP、添加自定义 MCP 服务、按席位授权/撤销工具权限，并在演练场实测 `ALLOW` 与 `403 DEFAULT-DENY`。
4. **⚙️ 本地执行手**：网页端一键重新初始化、查看滚动延迟与熔断器状态、可视化配置各 CLI 的无头参数与超时。
5. **🧬 RSI 与技能**：一键运行 10 轮 RSI 自改进循环（`R1 → R10`）、通过本地 CLI 蒸馏技能，或使用操作员模式一键创建并激活技能。
6. **📦 画布工件**：查看可移植工作区文件路径、在线编辑 JSON 数据集并原子发布新版本、查看 SHA-256 版本差分对比。
