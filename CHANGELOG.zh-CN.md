# 更新日志 (CHANGELOG)

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 规范。

---

## [未发布 (Unreleased)]

### 新增 (Added)
- **OpenCode CLI 模型手成为一等公民**：`opencode`（v2 `run --format json`）可被探测、可选择，并正式加入注册表 hand 集合（不再被当作 `codex` 别名）；新增其 NDJSON 事件流解析（`step_start` / `text` / `tool_use` / `step_finish` / `error`），支持按步 Token 统计与 `--session <id>` 会话续接。
- **DeepSeek Harness CLI 模型手（`dsh`）**：新增本地模型手，调用 `dsh --profile headless --json "<task>"`；解析 NDJSON 运行事件（`session` / `status` / `text` / `thinking` / `tool_call` / `tool_result` / `final`），支持 `--session-id <id>` 续接，并以步级 usage 聚合，任何一步缺少用量时绝不输出部分合计。
- Worker、注册表、CLI、默认/示例配置、Python `archon-hands` 适配器与用量解析器、能力探测，以及 Web 控制台的模型手选择器，均已支持五类模型手（`claude`、`codex`、`agy`、`opencode`、`dsh`）。

### 修复 (Fixed)
- **失败的模型手不再被当作成功答复**：opencode/dsh 现在要求退出码为 0 且没有引擎错误事件；中途失败但已输出部分文本的运行会判定失败，而不会成为助手答复。
- **旧的模型手配置可自愈**：历史版本写入的无头参数组合（opencode 缺 `--format json`/`--auto`、claude 使用 `--output-format text`）在加载时自动迁移，不再被 `npm run init` 反复写回。
- **macOS 专属副作用在 Linux 上被隔离**：异步任务完成通知不再因 `osascript` 异步 spawn 错误导致服务崩溃；「在文件管理器中显示」在非 macOS 上变为空操作。
- **会话与路由信息如实呈现**：降级不再把其它引擎的原生会话绑定到主模型手；执行手说明改为每次尝试重建；降级只选择已安装且启用的模型手，并受总时限约束。

### 测试 (Tests)
- 新增 opencode/dsh 调用与 NDJSON 投影的 Worker 测试、原生 `opencode`/`dsh` 注册表测试，以及 `dsh` 的 Python 适配器/用量/fixture 测试（合计 149 项）。

---

## [0.5.0] - 2026-11-07

### 新增 (Added)
- **ArchonOS Seat Memory v0.5（`L1–L4` 全席位 & 多模型手认知记忆体系）**：
  - **单写入者原话分片（Single-Writer Verbatim Shards，100% 事实无损保留）**：按 `shard://<seatId>/<entityId>` 追加写入原始数值、端口、域名与日期，彻底杜绝大模型摘要损耗。
  - **查询时三路融合（Wiki + 原话分片 + 指针融合）**：在默认预置的智枢幕僚长（`seat:chief-of-staff`）、操作者按需创建的任意专职席位（`seat:<custom-id>`）与本地 CLI 模型手（`agy`、`claude`、`codex`）每次执行前，单次检索同时融合 L3.5 领域 Wiki、单写入者原话分片与 L3 证据指针。
  - **反博尔赫斯领域 Wiki（Anti-Borges Domain Wiki，压缩率 `<= 0.15`）**：强制摘要体积不超过原始对话 Token 的 `15%`，超限页面自动降级为单行指针索引表。
  - **闭环 `规则 + 验证方式 + 陷阱告警` 抽取与 L4 Agora 剧本晋升**：经 Fable-5 显著性门控过滤后，自动抽取结构化规则与防踩坑告警，并将高置信度已验证规则（`confidence >= 0.90`）导出至 `.archon/agora-library/archonos-dreamed-seat-rules-v0.5.json`。

---

## [0.1.004] - 2026-10-23

### 安全与隐私防护 (Security & Privacy)
- **解耦默认预置 MCP、专职席位与私有数据集**：
  - 清空 `config/archon.defaults.json` 与 `config/archon.example.json` 中硬编码的操作者专有 MCP（`vortexa`、`agora`、`ros`）与私有 Worker 域名（`https://agora-hub.example.workers.dev`、`https://ros-gateway.example.workers.dev/mcp`）。
  - 重构 `packages/archon-worker/src/dev-server.mjs` 中的 `seedDefaultArchonWorkspace()`：默认仅注入法定入口席位（幕僚长 `chief-of-staff`）及基础回退席位（`seat-archon`），外部 MCP 严格从用户本地 `.archon/config.json` 动态加载。
  - 从源码预置阶段彻底移除了专职 MCP 权限授权（Grants）、私有计划任务（Schedules）及私有海运/本体数据集，避免新用户克隆安装时泄露操作者私有配置；同时通过 `.archon/workspace-state.json` 保持本机环境各项席位、MCP 与数据的完整延续。
  - 更新 `scripts/archon-init.mjs`，默认仅预置通用工作区编排技能，杜绝新用户初始安装对外部私有 API 的隐式依赖。

---

## [0.1.003] - 2026-10-22

### 修复 (Fixed)
- **Mermaid 语法报错清理与 DOM 隔离机制**：在 `packages/archon-app/public/index.html` 的 `renderMarkdownAndMermaid` 函数中加入错误注入元素自动清理逻辑。当 Mermaid 10.9 解析异常时，自动拦截并从 `document.body` 中移除全局残留的错误挂载节点（`#darchon-mermaid-X`），彻底防止在对话流与输入框下方残留“Syntax error in text”横幅；同时自动修复了历史会话中的连线括号语法。

---

## [0.1.002] - 2026-10-22

### 新增 (Added)
- **席位、MCP 与自定义技能隐私隔离机制**：在 `README.md` 与 `README.zh-CN.md` 中强化安全不变式规范。除统一对外入口幕僚长（Chief of Staff）外，其余专职席位（操作者自定义的各类专职席位 `seat:<custom-id>`）、已挂载的外部 MCP 接口句柄与操作者自定义私有技能，对外部或普通用户默认完全不可见且不可直接访问，保障个人核心环境隐私。

---

## [0.1.001] - 2026-10-22

### 新增 (Added)
- **多行自适应智能对话输入框**：将原有单行输入框全面重构为多行自适应 `textarea`，支持 `Shift+Enter` 快捷换行输入长段文字、结构化提示词与代码块，按 `Enter` 键直接发送指令。
- **工件引用对话即时修改 (`💬 引用修改 / Quote to Modify`)**：在画布顶部栏、视口工具栏、文件预览面板及工作区浏览器条目中全面增加一键引用按钮，点击后自动将当前版本（`rX`）锁定至输入托盘，支持自然语言驱动原地升级为 `rX+1`。
- **强制幕僚长自主预植入**：强化 `scripts/archon-init.mjs`，确保首次初始化自动将 `seat:chief-of-staff` 写入 `.archon/workspace-state.json` 与 `.archon/config.json`，保障系统开箱即具备全权总览协调能力。
- **全量双语文档对齐**：完整对齐中英文文档（`README.md`、`README.zh-CN.md`、快速入门、系统架构及配置治理文档）。
- **版本演进规范设立**：确立基准版本 `0.1.xxx` 递增规则，默认调整末尾三位数字。

### 变更 (Changed)
- **命名体系革新**：全面移除遗留的 "Sovereign"（主权）修饰，统一升级确立为**个人自进化智能操作系统 (Personal RSI Intelligent OS)**。
- **Warroom 解耦与完全单体独立**：明确系统定位为自包含、独立运行的个人智能操作系统，完全解耦外部 Warroom 强依赖，仅将 Warroom 与外部 MCP 网络作为按需启用的可选模块。
- **会话输出文件继承门禁优化**：在 `packages/archon-worker/src/dev-server.mjs` 中强化代码与界面任务启发式过滤，彻底杜绝讨论代码或 README 时错误继承前期研报输出文件的问题。

---

## [0.1.000] - 2026-10-20

### 新增 (Added)
- **ArchonOS 核心 Monorepo 代码库初始化**：9 个核心子包搭建与基线功能验证通过：
  - `archon-app`：双语分屏对话与 3D/2D 交互画布 PWA。
  - `archon-worker`：单源本地边缘服务器与 Durable Object 编排器。
  - `archon-registry`：严格模式与默认拒绝的 MCP 授权校验器。
  - `archon-skills-rsi`：Harness2 三值认知技能验证器。
  - `archon-canvas`：R2-First 原子化工件版本演进网关。
  - `archon-ledger`：基于 SHA-256 哈希链的审计安全账本。
  - `archon-hands`：本机无头 CLI 执行引擎接入层（`claude`、`codex`、`agy`、`opencode`）。
  - `archon-mesh`：基于 Ed25519 签名的工作区 Bundle 导出与导入。
  - `archon-cli`：命令行交互工具（`archon init`、`archon up`、`archon hand pair`）。
- **Antigravity 架构师闭环桥接**：实现 `/architect` 双向闭环调度，支持系统持续自迭代。
- **本机多模型执行手支持**：深度适配 Anthropic Claude Code、OpenAI Codex 与 Google Antigravity CLI。
