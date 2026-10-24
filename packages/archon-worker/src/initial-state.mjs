// Clean Starter Workspace State Snapshot for Public ArchonOS Edge Runtime
export const INITIAL_WORKSPACE_STATE = {
  "seats": [
    {
      "id": "chief-of-staff",
      "name_en": "Chief of Staff",
      "name_zh": "智枢幕僚长",
      "role_en": "Executive Synthesis & Cross-MCP Orchestration (Local CLI)",
      "role_zh": "全局综合研判与跨 MCP 协同调度 (本地 CLI)",
      "hand": "claude",
      "model": "cli-default",
      "budget": 1000000000,
      "enabled": true,
      "created_by": "operator",
      "persona": "You are the Chief of Staff of ArchonOS, a Sovereign Personal & Small-Team Intelligent OS. Answer concisely and analytically in the language requested by the user.",
      "capabilities": { "chat": true, "canvas": true, "mcp": true },
      "capabilities_set_by": "hand-operator",
      "engines": ["claude"],
      "handCustomizedByOperator": false
    },
    {
      "id": "seat-archon",
      "name_en": "Archon Core",
      "name_zh": "智枢核心",
      "role_en": "System Default Seat",
      "role_zh": "系统默认席位",
      "hand": "claude",
      "model": "cli-default",
      "budget": 1000000000,
      "enabled": true,
      "created_by": "operator",
      "persona": "You are Archon Core.",
      "capabilities": { "chat": true, "canvas": true, "mcp": true },
      "capabilities_set_by": "hand-operator",
      "engines": ["claude"],
      "handCustomizedByOperator": false
    },
    {
      "id": "code-architect",
      "name_en": "Code & Systems Architect",
      "name_zh": "架构与代码专家",
      "role_en": "Full-Stack Engineering & Architecture Seat",
      "role_zh": "全栈工程与系统架构席位",
      "hand": "claude",
      "model": "cli-default",
      "budget": 1000000000,
      "enabled": true,
      "created_by": "operator",
      "persona": "You are the Code & Systems Architect seat of ArchonOS. Provide sharp, accurate technical answers with Markdown and mermaid architecture diagrams when helpful.",
      "capabilities": { "chat": true, "canvas": true, "mcp": true },
      "capabilities_set_by": "hand-operator",
      "engines": ["claude"],
      "handCustomizedByOperator": false
    },
    {
      "id": "deep-research",
      "name_en": "Deep Research Analyst",
      "name_zh": "深度投研分析师",
      "role_en": "Multi-Source Research & Synthesis Seat",
      "role_zh": "多源深度研究与综合分析席位",
      "hand": "codex",
      "model": "cli-default",
      "budget": 1000000000,
      "enabled": true,
      "created_by": "operator",
      "persona": "You are the Deep Research Analyst seat of ArchonOS. Produce rigorous, evidence-backed analytical monographs.",
      "capabilities": { "chat": true, "canvas": true, "mcp": true },
      "capabilities_set_by": "hand-operator",
      "engines": ["codex"],
      "handCustomizedByOperator": false
    },
    {
      "id": "ops-guardian",
      "name_en": "Ops & Federation Guardian",
      "name_zh": "运维与联邦守卫",
      "role_en": "Security Gate, MCP Capability Grants & Federation Ops",
      "role_zh": "安全闸门、MCP 权限与联邦运维席位",
      "hand": "claude",
      "model": "cli-default",
      "budget": 1000000000,
      "enabled": true,
      "created_by": "operator",
      "persona": "You are the Ops & Federation Guardian seat of ArchonOS. Focus on operational telemetry, security invariants, and MCP health.",
      "capabilities": { "chat": true, "canvas": true, "mcp": true },
      "capabilities_set_by": "hand-operator",
      "engines": ["claude"],
      "handCustomizedByOperator": false
    }
  ],
  "artifacts": [
    {
      "artifactId": "art-telemetry-matrix",
      "workspaceId": "ws-default",
      "title": "ArchonOS Seat Spend, Hash-Chain Ledger & Local Hands Matrix",
      "kind": "dashboard",
      "currentRevision": 1,
      "currentManifestSha256": "seed-telemetry-sha256",
      "streamId": "stream-main",
      "currentSequence": 1,
      "publishedBySeat": "chief-of-staff",
      "metadata": {
        "localHtmlPath": "packages/archon-app/public/index.html",
        "localDataPath": ".archon/artifacts/art-telemetry-matrix.json",
        "webEmbedUrl": "/#telemetry",
        "mcpSource": "archon-internal"
      }
    }
  ],
  "artifactRevisions": [],
  "artifactBlobs": {},
  "skills": [
    {
      "name": "workspace-orchestrator-sop",
      "version": 1,
      "owner": "seat:chief-of-staff",
      "state": "active",
      "title": "Workspace Orchestrator & Multi-Seat Routing SOP",
      "description": "Default Chief of Staff executive routing, MCP capability governance, and Canvas synthesis protocol."
    }
  ],
  "schedules": [],
  "secureChannels": [],
  "teamGroups": []
};
