# Changelog

All notable changes to the ArchonOS project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **OpenCode CLI hand is now first-class**: `opencode` (v2 `run --format json`) is probed, selectable, resident in the registry hand set (no longer aliased to `codex`), and parsed from its NDJSON event stream (`step_start` / `text` / `tool_use` / `step_finish` / `error`), including per-step token accounting and `--session <id>` conversational continuity.
- **DeepSeek Harness CLI hand (`dsh`)**: new local hand invoking `dsh --profile headless --json "<task>"`, with NDJSON run-event parsing (`session` / `status` / `text` / `thinking` / `tool_call` / `tool_result` / `final`), `--session-id <id>` resume support, and step-level usage aggregation that never publishes a partial token sum.
- Worker, registry, CLI, config defaults/examples, Python `archon-hands` adapters/usage parsers/probe capabilities, and the web console hand selectors all list the five hands (`claude`, `codex`, `agy`, `opencode`, `dsh`).

### Fixed
- **Failed hand runs are no longer reported as answers**: opencode/dsh turns now require a zero exit status and no engine error event, so a mid-run provider failure with partial text fails the turn instead of becoming the assistant reply.
- **Stale hand configs self-heal**: shipped legacy headless argument sets (opencode without `--format json`/`--auto`, claude `--output-format text`) are migrated on load instead of being written back forever by `npm run init`.
- **macOS-only side effects are guarded on Linux**: the async job-completion notification no longer crashes the server through an unhandled `osascript` spawn error, and "reveal in file manager" is a no-op off macOS.
- **Session and routing honesty**: failover no longer binds another engine's native session to the primary hand, the executing-hand statement is rebuilt per attempt, and failover only targets installed/enabled hands under a bounded total deadline.

### Tests
- Added worker coverage for opencode/dsh invocation and NDJSON projection, registry coverage for native `opencode`/`dsh` hands, and Python adapter/usage/fixture coverage for `dsh` (149 total).

---

## [0.5.0] - 2026-11-07

### Added
- **ArchonOS Seat Memory v0.5 (`L1–L4` Multi-Seat & Multi-Hand Epistemic Memory)**:
  - **Single-Writer Verbatim Shards (`100% Fact Survival`)**: Deterministic `shard://<seatId>/<entityId>` append-only verbatim logs preserving exact numbers, ports, endpoints, and dates without LLM summarization loss.
  - **Query-Time Wiki + Shard + Pointer Fusion**: Single-pass retrieval fusing L3.5 Domain Wiki pages, Single-Writer Verbatim Shards, and L3 Execution Pointers (`turn://`, `artifact://`, `file://`, `skill://`, `mcp://`) before every execution across `seat:chief-of-staff`, any operator-defined specialist seat (`seat:<custom-id>`), and all local CLI hands (`agy`, `claude`, `codex`).
  - **Anti-Borges Domain Wiki (`Compression <= 0.15`)**: Enforces a strict `< 15%` token compression ratio relative to raw verbatim turns, automatically demoting verbose summaries to 1-line pointer tables.
  - **Closed-Loop `Rule + Verification + TrapWarning` & L4 Agora Playbook Promotion**: Extracts structured procedural rules and trap warnings (filtered by the Fable-5 Salience Gate) and promotes confirmed rules (`confidence >= 0.90`) to `.archon/agora-library/archonos-dreamed-seat-rules-v0.5.json`.

---

## [0.1.004] - 2026-10-23

### Security & Privacy
- **Decoupled Default MCPs, Specialist Seats & Private Datasets**:
  - Emptied `config/archon.defaults.json` and `config/archon.example.json` of hardcoded proprietary MCP servers (`vortexa`, `agora`, `ros`) and private endpoints (`https://agora-hub.example.workers.dev`, `https://ros-gateway.example.workers.dev/mcp`).
  - Refactored `seedDefaultArchonWorkspace()` in `packages/archon-worker/src/dev-server.mjs` to strictly seed the mandatory entry seat (`chief-of-staff`) and system fallback (`seat-archon`), dynamically importing MCP servers from local `.archon/config.json`.
  - Removed proprietary hardcoded MCP grants, schedules, and mock maritime datasets from default workspace seeding, preventing privacy leakage on fresh installations while preserving local operator workspace state via `.archon/workspace-state.json`.
  - Updated `scripts/archon-init.mjs` with starter generic orchestration skills, eliminating external API dependencies from the clean-clone initialization flow.

---

## [0.1.003] - 2026-10-22

### Fixed
- **Mermaid Syntax Error Cleanup & DOM Isolation**: Hardened `renderMarkdownAndMermaid` in `packages/archon-app/public/index.html` to automatically remove stray error elements injected by Mermaid 10.9 into `document.body` (`#darchon-mermaid-X`) on render failures, preventing global `Syntax error in text` banners from contaminating subsequent messages or the chat input tray. Repaired historical diagram syntax in workspace state.

---

## [0.1.002] - 2026-10-22

### Added
- **Seat, MCP & Custom Skill Privacy Invariant**: Documented and reinforced isolation boundaries in `README.md` and `README.zh-CN.md`. Except for the Chief of Staff serving as the unified conversational entrance, specialist seats (`seat:<custom-id>`), external MCP server handles, and private skills remain invisible and inaccessible to standard/external users.

---

## [0.1.001] - 2026-10-22

### Added
- **Multi-Line Intelligent Chatbox**: Upgraded chat input to a responsive, auto-expanding `textarea` with `Shift+Enter` for newline insertion and `Enter` for instant submission across desktop and mobile PWA views.
- **Interactive Artifact Quoting & Modification (`💬 Quote to Modify`)**: Added 1-click artifact quoting buttons across Canvas topbars, viewport toolbars, file preview panels, and workspace file rows, pinning artifact metadata (`rX`) to the chat composer tray for natural-language driven in-place revisions (`rX+1`).
- **Autonomous Chief of Staff Pre-Seeding**: Enhanced `scripts/archon-init.mjs` to mandate and pre-seed `seat:chief-of-staff` in `.archon/workspace-state.json` and `.archon/config.json` on initial boot, guaranteeing an active orchestrator out-of-the-box.
- **Bilingual Documentation Parity**: Synchronized English and Simplified Chinese documentation (`README.md`, `README.zh-CN.md`, Quickstart, Architecture, and Configuration guides).
- **Persistent Versioning Scheme**: Established the incremental versioning rule `0.1.xxx` with last-three-digit revision tracking.

### Changed
- **Nomenclature Refactoring**: Formally replaced legacy "Sovereign" nomenclature across all UI headers, ribbons, API routers, and documentation with **Personal RSI Intelligent OS** (`个人自进化智能操作系统`).
- **Warroom Independence & Decoupling**: Decoupled ArchonOS from mandatory Warroom orchestrators. ArchonOS operates as a completely independent, self-contained personal intelligent operating system, with Warroom and external MCP networks functioning purely as optional modular extensions.
- **Router Document Inheritance Gate**: Hardened `explicitlyWantsDocumentModification` in `packages/archon-worker/src/dev-server.mjs` with code/UI task heuristics to prevent false inheritance of earlier report files during codebase or architectural conversations.

---

## [0.1.000] - 2026-10-20

### Added
- **ArchonOS Core Monorepo Bootstrap**: Initial release of the 9-package monorepo architecture:
  - `archon-app`: Bilingual Split-View Chat & Interactive 3D/2D Canvas PWA.
  - `archon-worker`: Single-origin Edge server and Durable Object orchestrator.
  - `archon-registry`: Schema and authorization validator with default-deny MCP security.
  - `archon-skills-rsi`: Harness2 3-valued epistemic skill verifier.
  - `archon-canvas`: Atomic R2-first revision gate (`r1 → rN`).
  - `archon-ledger`: SHA-256 hash-chained policy ledger.
  - `archon-hands`: Headless CLI stream normalizer (`claude`, `codex`, `agy`, `opencode`).
  - `archon-mesh`: Ed25519-signed workspace bundle exporter and importer.
  - `archon-cli`: Command-line interface (`archon init`, `archon up`, `archon hand pair`).
- **Closed-Loop Antigravity Architect Bridge**: Bidirectional `/architect` dispatch loop for continuous automated codebase evolution.
- **Local Host Model Hands**: Headless execution integration across Anthropic Claude Code, OpenAI Codex, and Google Antigravity CLI.
