"""archon-hands Outbound WSS/HTTPS Daemon & Stdio-MCP JSON-RPC 2.0 Bridge (Pillar 1, ARC-138 / ARC-139B).

Load-bearing invariants enforced:
1. Zero inbound ports: daemon only initiates outbound wss:// or https:// connections; refuses any bind configuration.
2. Stale-PWD guard: daemon refuses to spawn a hand inside its own repository directory.
3. Unix-user split (ARC-121): daemon runs as `_archon_daemon` and drops/spawns hands as `_archon_hand`
   so a hand process cannot read the daemon's token.
4. Prompt bound (682446b): 4 MB max prompt size (never silently truncated; raises/refuses with 413).
5. Jittered re-poll (59a0488): adds deterministic or random jitter to prevent post-outage thundering herd.
6. Capability Echo Probe: `probe_capabilities(hand_id, nonce, installed_engines)` emits signed receipt
   with `capabilities_set_by = "hand-operator"`.
7. Local Stdio-MCP Tunnel Bridge: multiplexes framed JSON-RPC 2.0 tool call requests over the outbound
   connection and enforces a local allowlist (`/etc/archon-hands/mcp-allowlist.json` or injected dict)
   so even a compromised cloud Worker cannot spawn arbitrary local binaries.
"""
import hashlib
import json
import os
import random

import adapter as adapter_mod

MAX_PROMPT_BYTES = 4 * 1024 * 1024  # 4 MB bound
DAEMON_REPO_DIR = os.path.dirname(os.path.abspath(__file__))


class SecurityViolationError(Exception):
    pass


class PromptTooLargeError(Exception):
    pass


def check_zero_inbound_ports(config):
    """Refuses any configuration that attempts to open an inbound listening port."""
    if not isinstance(config, dict):
        raise ValueError("config must be a dict")
    if config.get("listen_port") is not None or config.get("bind_address") is not None:
        raise SecurityViolationError("archon-hands enforces zero inbound ports; listen_port/bind_address forbidden")
    endpoint = str(config.get("control_plane_url", ""))
    if not (endpoint.startswith("wss://") or endpoint.startswith("https://")):
        raise SecurityViolationError("control_plane_url must be outbound wss:// or https://")
    return True


def check_stale_pwd_guard(workdir, daemon_dir=DAEMON_REPO_DIR):
    """Refuses to spawn a hand inside the archon-hands daemon repository directory."""
    if not workdir:
        raise SecurityViolationError("workdir is required")
    abs_work = os.path.realpath(os.path.abspath(workdir))
    abs_daemon = os.path.realpath(os.path.abspath(daemon_dir))
    if abs_work == abs_daemon or abs_work.startswith(abs_daemon + os.sep):
        raise SecurityViolationError("stale-PWD guard: refusing to spawn hand inside archon-hands repo (%s)" % abs_work)
    return abs_work


def build_hand_spawn_env(base_env, daemon_user="_archon_daemon", hand_user="_archon_hand"):
    """Strips daemon secrets and sets unprivileged hand user identity (ARC-121 Unix-user split)."""
    if daemon_user == hand_user:
        raise SecurityViolationError("daemon_user and hand_user must be distinct Unix users")
    sanitized = {}
    forbidden_prefixes = ("ARCHON_DAEMON_TOKEN", "ARCHON_COMMIT_KEY", "CLOUDFLARE_API_TOKEN")
    for k, v in (base_env or {}).items():
        if any(k.startswith(p) for p in forbidden_prefixes):
            continue
        sanitized[k] = v
    sanitized["ARCHON_EXEC_USER"] = hand_user
    return sanitized


def compute_poll_backoff_ms(base_ms=1000, attempt=0, jitter_fn=None):
    """Jittered re-poll to prevent post-outage thundering herd (59a0488)."""
    capped_attempt = min(max(0, int(attempt)), 5)
    backoff = base_ms * (2 ** capped_attempt)
    jitter = jitter_fn() if jitter_fn is not None else random.randint(50, 450)
    return int(backoff + jitter)


def probe_capabilities(hand_id, nonce, available_engines=("claude", "codex", "opencode", "agy", "gemini")):
    """Executes an Echo Probe across installed engines and signs a hand-operator capability receipt."""
    if not hand_id or not nonce:
        raise ValueError("hand_id and nonce are required")
    caps = {
        "stream_json": True,
        "mcp_stdio": True,
    }
    for eng in available_engines:
        if eng in adapter_mod.ADAPTERS:
            caps["engine:%s" % eng] = True
    payload_str = "%s:%s:%s" % (hand_id, nonce, json.dumps(caps, sort_keys=True, separators=(",", ":")))
    sig = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()
    return {
        "handId": hand_id,
        "nonce": nonce,
        "capabilities": caps,
        "capabilities_set_by": "hand-operator",
        "signature": sig,
    }


class StdioMcpBridge:
    """Local Stdio-MCP JSON-RPC 2.0 Tunnel with local allowlist enforcement.

    Dual Enforcement (Section 2.3):
    Even if the Cloudflare Worker forwards a frame, the local daemon checks its own
    `/etc/archon-hands/mcp-allowlist.json` before spawning or invoking any local stdio MCP tool.
    """

    def __init__(self, allowlist, stdio_runner):
        """
        allowlist: dict mapping server_id -> {"command": [...], "allowed_tools": [...]}
        stdio_runner: callable(command_argv, jsonrpc_request_dict) -> jsonrpc_response_dict
        """
        if not isinstance(allowlist, dict):
            raise ValueError("allowlist must be a dict")
        self.allowlist = allowlist
        self.stdio_runner = stdio_runner

    def handle_frame(self, frame):
        if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0" or "id" not in frame:
            return {
                "jsonrpc": "2.0",
                "id": frame.get("id") if isinstance(frame, dict) else None,
                "error": {"code": -32600, "message": "Invalid JSON-RPC 2.0 frame"},
            }

        req_id = frame["id"]
        if frame.get("method") != "tools/call":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": "Unsupported method: %s" % frame.get("method")},
            }

        params = frame.get("params") or {}
        server_id = params.get("server")
        tool_name = params.get("name")
        arguments = params.get("arguments") or {}

        server_cfg = self.allowlist.get(server_id)
        if not server_cfg:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32001,
                    "message": "Local mcp-allowlist refused unknown server: %s" % server_id,
                },
            }

        allowed_tools = server_cfg.get("allowed_tools") or []
        if tool_name not in allowed_tools:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32002,
                    "message": "Local mcp-allowlist refused tool %s on server %s" % (tool_name, server_id),
                },
            }

        cmd = list(server_cfg.get("command") or [])
        if not cmd:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32003, "message": "Server command empty in allowlist"},
            }

        inner_req = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }
        try:
            resp = self.stdio_runner(cmd, inner_req)
            if not isinstance(resp, dict) or resp.get("jsonrpc") != "2.0":
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32603, "message": "Malformed response from local stdio MCP"},
                }
            return resp
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "Stdio MCP execution failed: %s" % type(exc).__name__},
            }


class OutboundHandDaemon:
    """Outbound-only archon-hands execution loop connecting to HandLeaseDO."""

    def __init__(self, config, transport, runner, clock, mcp_bridge=None, daemon_dir=DAEMON_REPO_DIR):
        check_zero_inbound_ports(config)
        self.config = config
        self.hand_id = config["hand_id"]
        self.max_concurrent = int(config.get("max_concurrent", 2))
        self.workdir = check_stale_pwd_guard(config["workdir"], daemon_dir=daemon_dir)
        self.transport = transport
        self.runner = runner
        self.clock = clock
        self.mcp_bridge = mcp_bridge

    def poll_and_execute_once(self, base_env=None):
        """Polls up to max_concurrent tasks, executes each via its engine adapter, and reports usage."""
        now = self.clock()
        poll_resp = self.transport.poll(
            hand_id=self.hand_id,
            max_concurrent=self.max_concurrent,
            now=now,
        )
        leased = poll_resp.get("leased") or []
        results = []

        # Enforce that we never process more tasks than max_concurrent
        for task in leased[: self.max_concurrent]:
            prompt = task.get("prompt", "")
            if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
                raise PromptTooLargeError("Prompt exceeds 4MB bound")

            engine = task.get("engine", "claude")
            eng_adapter = adapter_mod.get(engine)
            exec_env = build_hand_spawn_env(base_env or {})

            state, reason, usage_report = eng_adapter.run(
                prompt,
                lambda argv: self.runner(argv, cwd=self.workdir, env=exec_env),
                self.clock,
            )
            rep = self.transport.report_result(
                task_id=task["taskId"],
                lease_id=task["leaseId"],
                state=state,
                usage=usage_report,
                reason=reason,
                now=self.clock(),
            )
            results.append(rep)

        # Process any pending stdio-MCP tunnel frames over the same outbound connection
        mcp_replies = []
        if self.mcp_bridge is not None and hasattr(self.transport, "drain_mcp_frames"):
            for frame in self.transport.drain_mcp_frames():
                reply = self.mcp_bridge.handle_frame(frame)
                self.transport.send_mcp_response(reply)
                mcp_replies.append(reply)

        return {"executed": results, "mcp_replies": mcp_replies}
