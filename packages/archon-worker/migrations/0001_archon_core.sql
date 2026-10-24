-- ArchonOS Core Relational Schema (0001_archon_core.sql)
-- Covers Pillars 2, 3b, 3c, 3d, 3e, 3f, 3g (ARC-138 / ARC-139B / ARC-141)
-- Invariant: All monetary/budget columns are decimal strings or integer micro-units (never FLOAT/REAL).

PRAGMA foreign_keys = ON;

-- 1. Multi-Seat Registry (Capability map is set by hand operator probe, never self-claimed by seat)
CREATE TABLE IF NOT EXISTS seats (
  seat_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  persona_prompt TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('agy','claude','codex','opencode','gemini','container')),
  model TEXT NOT NULL,
  host_hand_id TEXT NOT NULL,
  capability_map_json TEXT NOT NULL,     -- Echo-verified by hand binary probe (@epistates 9188fc7d)
  capabilities_set_by TEXT NOT NULL DEFAULT 'hand-operator' CHECK (capabilities_set_by = 'hand-operator'),
  budget_per_period TEXT NOT NULL,       -- Decimal string / integer micro-units (required; absent stays absent, never 0/unlimited)
  period TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly','epoch')),
  rate_limit_per_hour INTEGER NOT NULL CHECK (rate_limit_per_hour > 0),
  policy_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 2. Crash-Safe Orchestrator Intents (Step 1: Intake)
CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('interactive','schedule','mesh','tool_result')),
  prompt TEXT NOT NULL,
  pinned_artifact_id TEXT,
  pinned_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN ('intake','planned','dispatching','harvesting','verifying','completed','failed','awaiting_approval','partial')),
  lock_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 3. Crash-Safe Orchestrator Tasks (Step 2-4: Plan, Governed Dispatch, Harvest)
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(intent_id),
  seat_id TEXT NOT NULL REFERENCES seats(seat_id),
  template_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work','control','probe','rsi_replay')),
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority >= 0 AND priority <= 10),
  budget_cap TEXT NOT NULL,              -- Decimal string / integer micro-units cap for this task
  lock_token TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','running','done','failed','no_result','expired','refused')),
  no_result_reason TEXT,
  result_blob_sha256 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 4. Append-Only, Hash-Chained Task Charge Ledger (@trade 903e0848 & 4afbd21e)
-- Spend is ALWAYS derived by summing over charges; restarting a process can never refill a budget.
CREATE TABLE IF NOT EXISTS charges (
  charge_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  seat_id TEXT NOT NULL REFERENCES seats(seat_id),
  schedule_fire_id TEXT,                 -- References (schedule_id@fire_time) when cron-triggered
  period_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tokens_in','tokens_out','tokens_cached','wall_ms','compute_s','tool_call','egress_bytes','unmetered_cap')),
  metered INTEGER NOT NULL CHECK (metered IN (0, 1)), -- 0 = unmetered (charged at task budget_cap)
  quantity INTEGER,                      -- NULL when metered = 0
  unit_price TEXT NOT NULL,              -- Decimal string
  amount TEXT NOT NULL,                  -- Decimal string / integer micro-units (never FLOAT/REAL)
  price_table_version TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- 5. Per-User Table-Driven Schedules & Alarm Fires (@ai-institute b6d58503 & @local-fabric a7a2dfdd)
CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY,
  seat_id TEXT NOT NULL REFERENCES seats(seat_id),
  template_key TEXT NOT NULL,
  cron_expr TEXT,
  fire_at INTEGER,                       -- For one-shot timers (XOR with cron_expr)
  catch_up_policy TEXT NOT NULL CHECK (catch_up_policy IN ('run_late','skip')),
  quiet_window_json TEXT NOT NULL,       -- Policy-defined maintenance/no-fly window
  per_fire_cap TEXT NOT NULL,            -- Decimal string
  period_cap TEXT NOT NULL,              -- Decimal string
  next_run INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  CHECK ((cron_expr IS NOT NULL AND fire_at IS NULL) OR (cron_expr IS NULL AND fire_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS schedule_fires (
  schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
  fire_time INTEGER NOT NULL,
  lease_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','done','failed','no_result','late','skipped','unclaimed','expired')),
  last_heartbeat_at INTEGER,
  PRIMARY KEY (schedule_id, fire_time)   -- Idempotency key: retried DO alarm cannot double-dispatch or double-charge
);

-- 6. Dynamic Third-Party MCP Registry & Default-Deny Grants (@ai-institute 54d6ff99)
CREATE TABLE IF NOT EXISTS mcp_servers (
  server_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('http','sse','stdio-bridge')),
  endpoint_or_cmd TEXT NOT NULL,
  secret_handle_ref TEXT CHECK (secret_handle_ref IS NULL OR secret_handle_ref LIKE 'secret://%'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_grants (
  grant_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,              -- 'archon' or 'seat:<seat_id>'
  server_id TEXT NOT NULL REFERENCES mcp_servers(server_id),
  tool_name TEXT NOT NULL,
  allow INTEGER NOT NULL CHECK (allow IN (0, 1)),
  transferable INTEGER NOT NULL DEFAULT 0 CHECK (transferable = 0),
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (author != subject_id)           -- Orchestrator or seat can never widen its own authority
);

CREATE TABLE IF NOT EXISTS mcp_access_counters (
  subject_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES mcp_servers(server_id),
  tool_name TEXT NOT NULL,
  invocation_count INTEGER NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  last_invoked_at INTEGER,
  PRIMARY KEY (subject_id, server_id, tool_name)
);

-- 7. Versioned Skill Bundles & harness2 Epistemic Verification Gate (@epistates 48875c08)
CREATE TABLE IF NOT EXISTS skills (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  bundle_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','retired','disabled')),
  proposed_by_harness INTEGER NOT NULL DEFAULT 0 CHECK (proposed_by_harness IN (0, 1)),
  replay_check TEXT CHECK (replay_check IN ('pass','fail','insufficient')),
  approved_by TEXT,
  approved_via_interactive INTEGER NOT NULL DEFAULT 0 CHECK (approved_via_interactive IN (0, 1)),
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_verification_records (
  record_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  skill_version_hash TEXT NOT NULL,
  verifier_version_hash TEXT NOT NULL,
  verifier_authored_with_proposal INTEGER NOT NULL CHECK (verifier_authored_with_proposal IN (0, 1)),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','insufficient')),
  n_heldout INTEGER NOT NULL,
  k_samples INTEGER NOT NULL,
  fit_trajectories_json TEXT NOT NULL,
  defeaters_open_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  needs_approval_rail INTEGER NOT NULL CHECK (needs_approval_rail IN (0, 1)),
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (skill_id, version) REFERENCES skills(skill_id, version)
);

-- 8. Archon Canvas Artifacts & Atomic Revision Pointers (@vibe 91a2941a)
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dashboard','brief','scene','table','audit')),
  current_revision INTEGER NOT NULL DEFAULT 0,
  current_manifest_sha256 TEXT,
  stream_id TEXT NOT NULL,
  current_sequence INTEGER NOT NULL DEFAULT 0,
  last_warning_banner TEXT,
  next_scheduled_refresh_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_revisions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  manifest_sha256 TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  published_by_seat TEXT NOT NULL,
  source_hashes_json TEXT NOT NULL,
  has_html_parity INTEGER NOT NULL CHECK (has_html_parity = 1),
  published_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, revision)
);

-- 9. Archon Mesh Provenance Graph, Quarantine, & Shared Seat Grants (@rho 7ba8d94b & @epistates 48875c08)
CREATE TABLE IF NOT EXISTS graph_objects (
  object_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  visibility TEXT NOT NULL,              -- 'private' | 'team:<id>' | 'link:<pubkey>'
  snapshot_sha256 TEXT,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  payload_json TEXT NOT NULL,
  basis_json TEXT NOT NULL,              -- (locator, content_sha256, n)
  defeaters_at_export_json TEXT NOT NULL,-- open defeaters + absence state ('none_held'|'outside_share'|'could_not_read')
  peer_as_of_json TEXT NOT NULL,         -- (graphVersion, observedAt)
  canonical_id_join TEXT NOT NULL,       -- Explicit mapping from peer kind:shortid to local canonical ID
  provenance_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (object_id, version)
);

CREATE TABLE IF NOT EXISTS mesh_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  sender_key TEXT NOT NULL,
  object_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_object_json TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seat_grants (
  seat_grant_id TEXT PRIMARY KEY,
  seat_id TEXT NOT NULL REFERENCES seats(seat_id),
  grantee_pubkey TEXT NOT NULL,
  allowed_templates_json TEXT NOT NULL,
  budget_quota TEXT NOT NULL,            -- Decimal string / integer micro-units
  expires_at INTEGER NOT NULL,
  transferable INTEGER NOT NULL DEFAULT 0 CHECK (transferable = 0),
  signature TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 10. Hands-Up Approval Rail (@trade 092b73e9)
CREATE TABLE IF NOT EXISTS approval_requests (
  request_id TEXT PRIMARY KEY,
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'grant_create','grant_widen','seat_update','schedule_upsert',
    'skill_activate','mcp_server_upsert','secret_rotate','mesh_share'
  )),
  proposer_id TEXT NOT NULL,
  grantee_id TEXT,
  origin_channel TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','refused')),
  decided_by TEXT,
  decided_via_interactive INTEGER CHECK (decided_via_interactive IN (0, 1)),
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
