#!/usr/bin/env node
// ArchonOS Dedicated Mesh Federation MCP Server (@mcp:archon-mesh)
// Agora-Style Team Workspaces, Topic Rooms & Sovereign Peer Coordination
//
// Hierarchy:
//   Team (team:<id>)
//     ├── Shared Workspace (skills, artifacts, resources) — visible to all rooms under Team
//     └── Topic Rooms (room:<team_id>:<topic>) — opened by topic; peers process messages locally
//
// Usage (stdio MCP server for Antigravity / Claude Code / Codex / OpenCode / Gemini CLI):
//   ARCHON_MESH_URL="https://archon-os-worker.workers.dev" \
//   ARCHON_ACCESS_KEY="ARCHON-KEY-..." \
//   node packages/archon-mesh/mcp-server.mjs

import readline from 'node:readline';

export const ARCHON_MESH_MCP_TOOLS = [
  {
    name: 'mesh_mint_access_key',
    description:
      'Mint a scoped access key (ARCHON-KEY-...) for a colleague to join a Team and its Topic Rooms via MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID (e.g., team:alpha)' },
        colleagueHandle: { type: 'string', description: 'Colleague handle (e.g., peer:alice)' },
        role: { type: 'string', enum: ['member', 'observer'], default: 'member' },
        allowedTopics: { type: 'array', items: { type: 'string' } },
      },
      required: ['teamId', 'colleagueHandle'],
    },
  },
  {
    name: 'mesh_join_team',
    description: 'Join an Archon Mesh Team using a minted accessKey (ARCHON-KEY-...) or inviteToken.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        accessKey: { type: 'string', description: 'Minted colleague access key (ARCHON-KEY-...)' },
        inviteToken: { type: 'string', description: 'Team invite token (ARC-CHAN-...)' },
        userId: { type: 'string', description: 'Peer handle (e.g., peer:alice)' },
        seatId: { type: 'string', default: 'seat:chief-of-staff' },
      },
    },
  },
  {
    name: 'mesh_list_teams_and_rooms',
    description:
      'List Archon Mesh Teams, their Shared Workspaces (skills, artifacts, resources), and Topic Rooms.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Optional Team ID filter' },
      },
    },
  },
  {
    name: 'mesh_open_room',
    description:
      'Open or join a Topic Room (room:<team_id>:<topic>) under a Team. Team shared workspace resources are visible to all rooms.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        topic: { type: 'string', description: 'Room topic slug or title (e.g., vlcc-freight-arb)' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['teamId', 'topic'],
    },
  },
  {
    name: 'mesh_read_room',
    description:
      'Read messages in a Topic Room along with the inherited Team Shared Workspace (skills, artifacts, resources) for local sovereign processing.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        roomId: { type: 'string' },
        topic: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'mesh_post_message',
    description: 'Post a message or synthesis to a Topic Room under a Team.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        roomId: { type: 'string' },
        topic: { type: 'string' },
        content: { type: 'string' },
        targetSeat: { type: 'string' },
        artifactId: { type: 'string' },
        skillId: { type: 'string' },
      },
      required: ['content'],
    },
  },
  {
    name: 'mesh_share_skill',
    description:
      'Share a Skill (SKILL.md + config) into the Team Shared Workspace so all Topic Rooms under the Team can see and import it.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        skillId: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'number', default: 1 },
        title: { type: 'string' },
        description: { type: 'string' },
        skillMd: { type: 'string' },
        config: { type: 'object' },
      },
      required: ['teamId', 'name'],
    },
  },
  {
    name: 'mesh_share_artifact',
    description:
      'Share an Artifact into the Team Shared Workspace so all Topic Rooms under the Team can see and import it.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        artifactId: { type: 'string' },
        title: { type: 'string' },
        kind: { type: 'string' },
        revision: { type: 'number', default: 1 },
        markdownContent: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['teamId', 'artifactId'],
    },
  },
  {
    name: 'mesh_import_shared_resource',
    description:
      'Fetch a shared Skill, Artifact, or Resource from the Team Shared Workspace to import into the local Archon instance.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        resourceType: {
          type: 'string',
          enum: ['skill', 'artifact', 'resource', 'all'],
          default: 'all',
        },
        resourceId: { type: 'string' },
      },
      required: ['teamId'],
    },
  },
];

export async function callRemoteArchonMeshMcp({
  baseUrl = process.env.ARCHON_MESH_URL || 'http://127.0.0.1:8790',
  accessKey = process.env.ARCHON_ACCESS_KEY || '',
  adminToken = process.env.ARCHON_ADMIN_TOKEN || '',
  tool,
  args = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/api/mcp/archon-mesh`;
  const headers = { 'content-type': 'application/json' };
  const token = accessKey || args.accessKey || adminToken;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

export function startArchonMeshStdioServer({
  baseUrl = process.env.ARCHON_MESH_URL || 'http://127.0.0.1:8790',
  accessKey = process.env.ARCHON_ACCESS_KEY || '',
  adminToken = process.env.ARCHON_ADMIN_TOKEN || '',
} = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const send = (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'archon-mesh',
            version: '1.0.0',
          },
        },
      });
      return;
    }
    if (method === 'notifications/initialized') {
      return;
    }
    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: ARCHON_MESH_MCP_TOOLS },
      });
      return;
    }
    if (method === 'tools/call') {
      try {
        const result = await callRemoteArchonMeshMcp({
          baseUrl,
          accessKey,
          adminToken,
          tool: params?.name,
          args: params?.arguments || {},
        });
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: !result?.ok,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Error calling @mcp:archon-mesh: ${err.message}` }],
          },
        });
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startArchonMeshStdioServer();
}
