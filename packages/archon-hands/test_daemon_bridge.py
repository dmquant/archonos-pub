import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import daemon  # noqa: E402


class FakeOutboundTransport:
    def __init__(self, leased_tasks=None, mcp_frames=None):
        self.leased_tasks = list(leased_tasks or [])
        self.mcp_frames = list(mcp_frames or [])
        self.reported = []
        self.mcp_responses = []

    def poll(self, hand_id, max_concurrent, now):
        batch = self.leased_tasks[:max_concurrent]
        self.leased_tasks = self.leased_tasks[max_concurrent:]
        return {"ok": True, "leased": batch, "freeSlots": max(0, max_concurrent - len(batch))}

    def report_result(self, task_id, lease_id, state, usage, reason, now):
        rec = {
            "taskId": task_id,
            "leaseId": lease_id,
            "state": state,
            "usage": usage,
            "reason": reason,
            "now": now,
        }
        self.reported.append(rec)
        return rec

    def drain_mcp_frames(self):
        frames = list(self.mcp_frames)
        self.mcp_frames = []
        return frames

    def send_mcp_response(self, reply):
        self.mcp_responses.append(reply)


class DaemonAndBridgeTests(unittest.TestCase):
    def test_zero_inbound_ports_enforced(self):
        with self.assertRaises(daemon.SecurityViolationError):
            daemon.check_zero_inbound_ports({"control_plane_url": "wss://archon.example/hands", "listen_port": 8080})
        with self.assertRaises(daemon.SecurityViolationError):
            daemon.check_zero_inbound_ports({"control_plane_url": "http://insecure.example/hands"})
        self.assertTrue(daemon.check_zero_inbound_ports({"control_plane_url": "wss://archon.example/hands"}))

    def test_stale_pwd_guard_refuses_daemon_repo(self):
        with self.assertRaises(daemon.SecurityViolationError):
            daemon.check_stale_pwd_guard(daemon.DAEMON_REPO_DIR)
        with self.assertRaises(daemon.SecurityViolationError):
            daemon.check_stale_pwd_guard(os.path.join(daemon.DAEMON_REPO_DIR, "fixtures"))
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertEqual(daemon.check_stale_pwd_guard(tmpdir), os.path.realpath(tmpdir))

    def test_unix_user_split_strips_daemon_tokens(self):
        with self.assertRaises(daemon.SecurityViolationError):
            daemon.build_hand_spawn_env({}, daemon_user="same", hand_user="same")
        raw_env = {
            "PATH": "/usr/bin:/bin",
            "ARCHON_DAEMON_TOKEN": "secret-daemon-token",
            "ARCHON_COMMIT_KEY": "secret-e2ee-key",
            "CLOUDFLARE_API_TOKEN": "cf-token",
        }
        clean = daemon.build_hand_spawn_env(raw_env)
        self.assertNotIn("ARCHON_DAEMON_TOKEN", clean)
        self.assertNotIn("ARCHON_COMMIT_KEY", clean)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", clean)
        self.assertEqual(clean["ARCHON_EXEC_USER"], "_archon_hand")

    def test_jittered_poll_backoff(self):
        self.assertEqual(daemon.compute_poll_backoff_ms(1000, attempt=0, jitter_fn=lambda: 120), 1120)
        self.assertEqual(daemon.compute_poll_backoff_ms(1000, attempt=2, jitter_fn=lambda: 50), 4050)

    def test_capability_echo_probe(self):
        receipt = daemon.probe_capabilities("hand-sg01", "nonce-99")
        self.assertEqual(receipt["handId"], "hand-sg01")
        self.assertEqual(receipt["capabilities_set_by"], "hand-operator")
        self.assertTrue(receipt["capabilities"]["engine:claude"])
        self.assertEqual(len(receipt["signature"]), 64)

    def test_stdio_mcp_bridge_enforces_local_allowlist(self):
        allowlist = {
            "local-sqlite": {
                "command": ["sqlite-mcp", "--readonly"],
                "allowed_tools": ["query_table"],
            }
        }
        bridge = daemon.StdioMcpBridge(
            allowlist,
            lambda cmd, req: {"jsonrpc": "2.0", "id": req["id"], "result": {"rows": [[1]], "cmd": cmd}},
        )

        # Unknown server refused locally
        r1 = bridge.handle_frame({
            "jsonrpc": "2.0",
            "id": "rpc-1",
            "method": "tools/call",
            "params": {"server": "arbitrary-shell", "name": "exec", "arguments": {}},
        })
        self.assertIn("error", r1)
        self.assertEqual(r1["error"]["code"], -32001)

        # Unlisted tool on allowed server refused locally
        r2 = bridge.handle_frame({
            "jsonrpc": "2.0",
            "id": "rpc-2",
            "method": "tools/call",
            "params": {"server": "local-sqlite", "name": "drop_database", "arguments": {}},
        })
        self.assertIn("error", r2)
        self.assertEqual(r2["error"]["code"], -32002)

        # Allowlisted server + tool succeeds
        r3 = bridge.handle_frame({
            "jsonrpc": "2.0",
            "id": "rpc-3",
            "method": "tools/call",
            "params": {"server": "local-sqlite", "name": "query_table", "arguments": {"sql": "SELECT 1"}},
        })
        self.assertIn("result", r3)
        self.assertEqual(r3["result"]["rows"], [[1]])

    def test_outbound_daemon_poll_execute_and_mcp_tunnel(self):
        with tempfile.TemporaryDirectory() as workdir:
            transport = FakeOutboundTransport(
                leased_tasks=[
                    {
                        "taskId": "t-100",
                        "leaseId": "L1",
                        "engine": "claude",
                        "prompt": "Verify tank capacity",
                    }
                ],
                mcp_frames=[
                    {
                        "jsonrpc": "2.0",
                        "id": "rpc-10",
                        "method": "tools/call",
                        "params": {"server": "local-sqlite", "name": "query_table", "arguments": {}},
                    }
                ],
            )
            allowlist = {
                "local-sqlite": {
                    "command": ["sqlite-mcp"],
                    "allowed_tools": ["query_table"],
                }
            }
            bridge = daemon.StdioMcpBridge(
                allowlist,
                lambda cmd, req: {"jsonrpc": "2.0", "id": req["id"], "result": {"ok": True}},
            )
            ticks = iter([10, 11, 14, 15])

            def fake_runner(argv, cwd, env):
                self.assertEqual(env["ARCHON_EXEC_USER"], "_archon_hand")
                self.assertNotIn("ARCHON_DAEMON_TOKEN", env)
                claude_line = '{"type":"result","duration_ms":3000,"usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":0,"output_tokens":4}}'
                return 0, [claude_line]

            d = daemon.OutboundHandDaemon(
                config={
                    "hand_id": "sg01-hand",
                    "control_plane_url": "wss://archon.example/hands",
                    "max_concurrent": 2,
                    "workdir": workdir,
                },
                transport=transport,
                runner=fake_runner,
                clock=lambda: next(ticks),
                mcp_bridge=bridge,
            )
            summary = d.poll_and_execute_once({"ARCHON_DAEMON_TOKEN": "top-secret"})
            self.assertEqual(len(summary["executed"]), 1)
            self.assertEqual(summary["executed"][0]["state"], "done")
            self.assertEqual(summary["executed"][0]["usage"]["input_uncached"]["value"], 10)
            self.assertEqual(len(summary["mcp_replies"]), 1)
            self.assertTrue(summary["mcp_replies"][0]["result"]["ok"])


if __name__ == "__main__":
    unittest.main()
