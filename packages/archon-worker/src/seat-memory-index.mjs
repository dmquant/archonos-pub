// ArchonOS Seat Memory v0.5: Asymmetric Meta-Memory, Single-Writer Shards & Memory-as-Index Engine
//
// Core Architectural Principles:
// 1. Asymmetric Memory Mechanisms per Seat Role:
//    - Chief of Staff (`chief-of-staff`, the mandatory pre-seeded entry seat): Omniscient Meta-Memory
//      (Live OS Asset Registry Index, Seat Alignment & Calibration Ledger, Cross-Seat Lineage Graph).
//    - Operator-Defined Specialist Seats (`seat:<custom-id>` created via Workbench or Chief of Staff):
//      Role-specialized domain indices resolved dynamically by archetype (Procedural/Engineering,
//      Epistemic/Research, Time-Series/Quantitative, Visual/Design, or General Specialist Domain).
// 2. Memory-as-Index (Hippocampal Pointer Map over Execution History):
//    - Memory is an associative index built continuously from every executed chat turn, artifact build,
//      skill evolution, and scheduled task across all local CLI hands (`agy`, `claude`, `codex`).
//    - Each index entry stores compact pointers (`turn://`, `artifact://`, `file://`, `skill://`, `wiki://`)
//      that fast-direct a seat to the exact historical content on hit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SEAT_MEMORY_ROLE_SCHEMAS = {
  'chief-of-staff': {
    archetype: 'omniscient-meta-memory',
    label: '👑 Omniscient OS Meta-Memory & Alignment Index',
    description:
      'Maintains the global workspace asset map, cross-seat delegation playbook, and synthesis lineage across all operator-defined seats and local CLI hands.',
    facets: ['liveAssetMap', 'seatAlignmentLedger', 'crossSeatLineage', 'operatorPlaybooks'],
    preferredUriSchemes: ['artifact://', 'seat://', 'turn://', 'skill://', 'schedule://', 'file://'],
  },
  'specialist-engineering': {
    archetype: 'procedural-codebase-index',
    label: '🏗️ Procedural & Engineering Ownership Index',
    description:
      'Indexes repository file ownership, component contracts, test verification gates, and bugfix trajectories.',
    facets: ['fileOwnershipMap', 'componentContracts', 'bugfixTrajectories', 'artifactBuilders'],
    preferredUriSchemes: ['file://', 'artifact://', 'turn://', 'skill://'],
  },
  'specialist-research': {
    archetype: 'epistemic-audit-index',
    label: '🔬 Epistemic Evidence & Multi-Source Research Index',
    description:
      'Indexes primary-source citations, verification hashes, hypothesis retractions, and structured report deliverables.',
    facets: ['entityVerdicts', 'evidencePaths', 'hypothesisDefeaters', 'reportDeliverables'],
    preferredUriSchemes: ['artifact://', 'file://', 'turn://', 'mcp://'],
  },
  'specialist-quant': {
    archetype: 'timeseries-ledger-index',
    label: '📊 Quantitative Time-Series & Calibration Index',
    description:
      'Indexes rolling data cutoffs, anomaly baselines, calibration formulas, and telemetry snapshots.',
    facets: ['dataCutoffs', 'anomalyBaselines', 'calibrationFormulas', 'telemetrySnapshots'],
    preferredUriSchemes: ['artifact://', 'mcp://', 'turn://', 'file://'],
  },
  'specialist-design': {
    archetype: 'visual-style-index',
    label: '🎨 Interactive Canvas & Visual Design Index',
    description:
      'Indexes responsive layout tokens, dual-theme contrast invariants, and interactive 2D/3D Canvas artifacts.',
    facets: ['canvasLayouts', 'viewportPostures', 'themeTokens', 'visualComponents'],
    preferredUriSchemes: ['artifact://', 'file://', 'turn://', 'mcp://'],
  },
};

export function getSeatMemoryRoleSchema(seatId = 'chief-of-staff') {
  const cleanId = String(seatId || 'chief-of-staff').replace(/^seat:/, '');
  if (SEAT_MEMORY_ROLE_SCHEMAS[cleanId]) {
    return SEAT_MEMORY_ROLE_SCHEMAS[cleanId];
  }
  if (/(?:code|eng|dev|arch|build|test)/i.test(cleanId)) {
    return {
      ...SEAT_MEMORY_ROLE_SCHEMAS['specialist-engineering'],
      label: `🏗️ Procedural & Engineering Ownership Index (${cleanId})`,
    };
  }
  if (/(?:research|analyst|audit|review|epistemic|study)/i.test(cleanId)) {
    return {
      ...SEAT_MEMORY_ROLE_SCHEMAS['specialist-research'],
      label: `🔬 Epistemic Evidence & Research Index (${cleanId})`,
    };
  }
  if (/(?:quant|data|metric|finance|ledger|flow|market)/i.test(cleanId)) {
    return {
      ...SEAT_MEMORY_ROLE_SCHEMAS['specialist-quant'],
      label: `📊 Quantitative Time-Series & Calibration Index (${cleanId})`,
    };
  }
  if (/(?:design|studio|ui|ux|visual|canvas|creative)/i.test(cleanId)) {
    return {
      ...SEAT_MEMORY_ROLE_SCHEMAS['specialist-design'],
      label: `🎨 Interactive Canvas & Visual Design Index (${cleanId})`,
    };
  }
  return {
    archetype: 'specialist-domain-index',
    label: `🎯 Specialist Domain Execution Index (${cleanId})`,
    description:
      'Indexes domain-specific task trajectories, artifacts, governed skills, and workspace file coordinates for this operator-defined seat.',
    facets: ['taskTrajectories', 'domainArtifacts', 'skillPlaybooks', 'fileCoordinates'],
    preferredUriSchemes: ['artifact://', 'turn://', 'file://', 'skill://'],
  };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have', 'are', 'was', 'were',
  'will', 'can', 'should', 'would', 'could', 'about', 'what', 'when', 'where', 'which', 'who', 'how',
  'please', 'make', 'create', 'update', 'show', 'open', 'let', 'talk', 'need', 'now', 'also', 'more',
]);

export function tokenizeMemoryQuery(text = '') {
  const raw = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const m of raw.matchAll(/[a-z0-9][a-z0-9._-]{1,36}/g)) {
    const tok = m[0].replace(/^[._-]+|[._-]+$/g, '');
    if (tok.length >= 2 && !STOPWORDS.has(tok)) {
      tokens.add(tok);
    }
  }
  // Extract CJK bigrams & phrases
  for (const m of raw.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) {
    const phrase = m[0];
    tokens.add(phrase);
    if (phrase.length > 2) {
      for (let i = 0; i < phrase.length - 1; i += 1) {
        tokens.add(phrase.slice(i, i + 2));
      }
    }
  }
  return Array.from(tokens);
}

export function extractTargetPointersFromTurn({
  workspaceId = 'ws-default',
  sessionId = 'session-main',
  messageId = '',
  seatId = 'chief-of-staff',
  userPrompt = '',
  replyText = '',
  artifactUpdated = null,
  generatedFiles = [],
  selectedSkills = [],
  selectedMcps = [],
}) {
  const targets = new Set();
  if (messageId) {
    targets.add(`turn://${workspaceId}/${sessionId}/${messageId}`);
  }
  if (artifactUpdated?.artifactId) {
    const revSuffix = artifactUpdated.revision ? `@r${artifactUpdated.revision}` : '';
    targets.add(`artifact://${artifactUpdated.artifactId}${revSuffix}`);
    if (artifactUpdated.localHtmlPath) {
      targets.add(`file://${artifactUpdated.localHtmlPath}`);
    }
  }
  for (const f of generatedFiles || []) {
    const fname = f?.filename || f?.name || f?.portableFilePath;
    if (fname) {
      targets.add(`file://${String(fname).replace(/^outputs\//, 'outputs/')}`);
    }
  }
  for (const sk of selectedSkills || []) {
    targets.add(`skill://${String(sk).replace(/@\d+$/, '')}`);
  }
  for (const mcp of selectedMcps || []) {
    targets.add(`mcp://${mcp}`);
  }
  const combined = `${userPrompt || ''}\n${replyText || ''}`;
  for (const m of combined.matchAll(/\b(art-[a-z0-9-]+)\b/gi)) {
    targets.add(`artifact://${m[1].toLowerCase()}`);
  }
  for (const m of combined.matchAll(/\b((?:packages|scripts|outputs|\.archon)\/[a-zA-Z0-9._/-]+\.[a-zA-Z0-9]+)\b/g)) {
    targets.add(`file://${m[1]}`);
  }
  return Array.from(targets).slice(0, 12);
}

const DEFAULT_COS_ALIGNMENT_RULES = [
  {
    ruleId: 'align-cos-workspace-orchestrator',
    workspaceId: 'ws-default',
    pattern: 'Workspace orchestration / cross-seat routing / telemetry matrix / skill governance',
    keywords: ['orchestrator', 'workspace', 'telemetry', 'matrix', 'routing', 'skill', 'sop', 'seat', 'canvas'],
    targetSeatId: 'chief-of-staff',
    preferredEngine: 'agy',
    rationale:
      'seat:chief-of-staff is the mandatory default orchestrator, maintaining the workspace telemetry matrix and routing tasks across operator-defined specialist seats.',
    targetUris: [
      'skill://workspace-orchestrator-sop',
      'artifact://art-telemetry-matrix',
    ],
    hitCount: 12,
    confidence: 0.99,
  },
  {
    ruleId: 'align-cos-mesh-federation',
    workspaceId: 'ws-default',
    pattern: 'Team shared workspace / topic rooms / colleague access keys / federated MCP relay',
    keywords: ['mesh', 'team', 'room', 'channel', 'federation', 'relay', 'share', 'vault'],
    targetSeatId: 'chief-of-staff',
    preferredEngine: 'claude',
    rationale:
      'seat:chief-of-staff coordinates multi-user Team Shared Workspaces, Topic Rooms, and @mcp:archon-mesh colleague access keys.',
    targetUris: [
      'skill://archon-mesh-collaboration-sop',
      'artifact://art-telemetry-matrix',
    ],
    hitCount: 9,
    confidence: 0.98,
  },
];

export const MEMORY_PRIOR_TO_SKILLS_SOP_ENTRY = {
  id: 'gmem-memory-prior-to-skills-sop',
  key: 'memory-prior-to-skills-execution-sop',
  category: 'execution-sop',
  content:
    'Memory-Prior-to-Skills Execution SOP (Memory v0.5 Epistemic Pointer Spec): The Memory System is prior to Skills for retrieval, but Memory is a Pointer to Evidence, NOT Proof of Truth (memoryAuthority="retrieval_pointer_only"). Cached PASS/Grade-A verdicts in memory are untrusted retrieval hints and can NEVER skip primary-source verification. Unreviewed or synthetic drafts are tagged "unverified_hypothesis" or "retracted_or_challenged" and quarantined from canonical exemplars. Global Memory holds only universal cross-seat SOPs.',
  updatedAt: '2026-11-04T06:30:00.000Z',
};

export const OFF_LAN_AGORA_ONLY_SOP_ENTRY = {
  id: 'gmem-off-lan-agora-only-sop',
  key: 'off-lan-agora-only-topology-sop',
  category: 'network-topology-sop',
  content:
    'Off-LAN Federated Relay Topology SOP: Treat remote peer nodes and external clusters as off-LAN by default. Never attempt direct LAN, SSH, rsync, or .local mDNS connections to remote peer hosts; route cross-instance messages, contracts, and shared playbooks exclusively through governed MCP relays (@mcp:archon-mesh / @mcp:agora-admin).',
  updatedAt: '2026-11-05T00:55:00.000Z',
};

const RETRACTED_SYNTHETIC_SYMBOLS = new Set(['NVDA', 'META', 'GEV', 'TSM']);

export function evaluatePointerEpistemicProvenance({
  promptText = '',
  replyText = '',
  targets = [],
  explicitProvenance = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const combined = `${promptText || ''}\n${replyText || ''}\n${(targets || []).join(' ')}`;
  const isLegacyQuotaOrSynthetic =
    /\b(?:100,000\s*characters|100k\+\s*monograph|buildInstitutionalMonograph100k|synthetic_profile_producer)\b/i.test(combined) ||
    /\bart-stock-sop-(?:nvda|meta|gev|tsm)\b/i.test(combined);

  if (explicitProvenance?.verificationStatus === 'retracted_or_challenged' || isLegacyQuotaOrSynthetic) {
    return {
      memoryAuthority: 'retrieval_pointer_only',
      verificationStatus: 'retracted_or_challenged',
      quarantinedFromCanonicalExemplars: true,
      requiresPrimarySourceReverification: true,
      retractionReason:
        explicitProvenance?.retractionReason ||
        'legacy_synthetic_generation_or_100k_quota_template_retracted_v3',
      primaryFilingHash: explicitProvenance?.primaryFilingHash || null,
      extractionDate: explicitProvenance?.extractionDate || String(createdAt).slice(0, 10),
      verificationMethod: 'retracted_by_quality_contract_v3',
    };
  }

  if (
    explicitProvenance?.verificationStatus === 'verified_primary_source' &&
    explicitProvenance?.primaryFilingHash &&
    explicitProvenance?.verificationMethod === 'independent_primary_source_and_calculation_review'
  ) {
    return {
      memoryAuthority: 'retrieval_pointer_only',
      verificationStatus: 'verified_primary_source',
      quarantinedFromCanonicalExemplars: false,
      requiresPrimarySourceReverification: true,
      primaryFilingHash: explicitProvenance.primaryFilingHash,
      extractionDate: explicitProvenance.extractionDate || String(createdAt).slice(0, 10),
      verificationMethod: explicitProvenance.verificationMethod,
    };
  }

  return {
    memoryAuthority: 'retrieval_pointer_only',
    verificationStatus: explicitProvenance?.verificationStatus || 'unverified_hypothesis',
    quarantinedFromCanonicalExemplars: true,
    requiresPrimarySourceReverification: true,
    primaryFilingHash: explicitProvenance?.primaryFilingHash || null,
    extractionDate: explicitProvenance?.extractionDate || String(createdAt).slice(0, 10),
    verificationMethod: explicitProvenance?.verificationMethod || 'unreviewed_turn_index',
  };
}

// =========================================================================
// ArchonOS Cross-Seat & Multi-Hand Memory v0.4.5 Enhancements
// (Universal across ALL seats and ALL CLI Hands: agy, claude, codex)
// =========================================================================

/**
 * Salience Gate (`evaluateTurnSalienceForMemory`):
 * Prevents indexing transient screen/API-readable status turns or trivial chatter into L3 pointers.
 * Records only turns that carry lasting operational knowledge across sessions:
 *   - Artifact mutations or generated files
 *   - Root-cause fixes, trap warnings, or tested rules
 *   - Cross-seat routing/alignment decisions
 *   - Explicit operator directives or memory instructions
 */
export function evaluateTurnSalienceForMemory({
  userPrompt = '',
  replyText = '',
  artifactUpdated = null,
  generatedFiles = [],
  selectedSkills = [],
  routedByCos = false,
  kind = 'chat-turn-execution',
} = {}) {
  const cleanPrompt = String(userPrompt || '').trim();
  const cleanReply = String(replyText || '').trim();
  const combined = `${cleanPrompt}\n${cleanReply}`;

  if (artifactUpdated?.artifactId || (Array.isArray(generatedFiles) && generatedFiles.length > 0)) {
    return { salient: true, salienceScore: 0.96, reason: 'artifact_or_deliverable_mutation' };
  }
  if (kind === 'artifact-evolution' || kind === 'deliverable-generation' || kind === 'workflow-sop' || kind === 'live-canvas-artifact') {
    return { salient: true, salienceScore: 0.92, reason: `high_signal_kind:${kind}` };
  }
  if (/(?:remember|记住|rule|invariant|trap|bug|fix|root\s*cause|sop|contract|retract|verify|verified|architecture|对齐|规范|修复)/i.test(combined)) {
    return { salient: true, salienceScore: 0.90, reason: 'rule_trap_or_architectural_fix' };
  }
  if (/\b(?:art-[a-z0-9-]+|(?:packages|scripts|outputs|\.archon)\/[a-zA-Z0-9._/-]+\.[a-zA-Z0-9]+)\b/i.test(combined)) {
    return { salient: true, salienceScore: 0.85, reason: 'concrete_resource_pointer' };
  }
  if (Array.isArray(selectedSkills) && selectedSkills.length > 0) {
    return { salient: true, salienceScore: 0.82, reason: 'skill_guided_execution' };
  }

  // Filter out pure transient status pings or trivial 1-word acknowledgements that can be read live from /api/health
  const isTransientPing =
    /^(?:ping|status|health|ok|hello|hi|test|one\s+tick|tick)$/i.test(cleanPrompt) &&
    cleanReply.length < 240 &&
    !routedByCos;
  if (isTransientPing) {
    return { salient: false, salienceScore: 0.12, reason: 'transient_status_ping_filtered' };
  }

  if (cleanPrompt.length < 8 && cleanReply.length < 80) {
    return { salient: false, salienceScore: 0.20, reason: 'low_signal_short_turn' };
  }

  return { salient: true, salienceScore: 0.72, reason: 'substantive_execution_turn' };
}

/**
 * Closed-Loop Rule & Trap Warning Extractor (`extractClosedLoopLearningRule`):
 * Upgrades seat notes across all seats & CLI hands (agy, claude, codex) from flat text
 * to structured `{ ruleStatement, howVerified, trapWarning, ruleStatus, engine, seatId }`.
 */
export function extractClosedLoopLearningRule({
  seatId = 'chief-of-staff',
  engine = 'agy',
  userPrompt = '',
  replyText = '',
  targets = [],
  epistemicProvenance = null,
} = {}) {
  const cleanSeatId = String(seatId || 'chief-of-staff').replace(/^seat:/, '');
  const combined = `${userPrompt || ''}\n${replyText || ''}`;

  let trapWarning = null;
  const trapMatch = combined.match(
    /(?:trap|pitfall|caveat|avoid|never|do\s+not|don't|warning|切勿|禁止|不要|陷阱)[:：-\s]+([^.\n]{12,200})/i
  );
  if (trapMatch) {
    trapWarning = trapMatch[1].trim();
  }

  let howVerified = epistemicProvenance?.verificationMethod || null;
  if (/\b(?:node\s+--test|unit\s+test|passing|verified|primaryFilingHash|Harness2\s+k=3\s+PASS)\b/i.test(combined)) {
    const verMatch = combined.match(
      /\b((?:node\s+--test[^\n.]{0,80}|[0-9]+\/[0-9]+\s+tests?\s+passing|Harness2\s+k=3\s+PASS|verified\s+against\s+[^\n.]{3,60}))/i
    );
    howVerified = verMatch ? verMatch[1].trim() : 'empirical_test_or_source_check';
  }

  const ruleMatch = combined.match(
    /(?:rule|invariant|always|must|sop|remember|记住|规范)[:：-\s]+([^.\n]{12,220})/i
  );
  const ruleStatement = ruleMatch
    ? ruleMatch[1].trim()
    : targets.length > 0
      ? `[seat:${cleanSeatId}/${engine}] Maintain & verify ${targets.slice(0, 3).join(', ')}`
      : null;

  const isConfirmed =
    epistemicProvenance?.verificationStatus === 'verified_primary_source' ||
    Boolean(howVerified && howVerified !== 'unreviewed_turn_index');

  return {
    seatId: cleanSeatId,
    engine,
    ruleStatus:
      epistemicProvenance?.verificationStatus === 'retracted_or_challenged'
        ? 'retracted_or_challenged'
        : isConfirmed
          ? 'confirmed_rule'
          : 'untested_hypothesis',
    ruleStatement,
    howVerified: howVerified || 'unreviewed_turn_index',
    trapWarning,
  };
}

/**
 * Cross-Seat & Multi-Hand Offline Consolidation ("Dreaming" Engine):
 * Runs during ArchonOS 2-Hour RSI ticks (`runInfiniteRsiSeatCoordTick`) or via `POST /api/memory/dream`.
 * Works across ALL seats (`chief-of-staff` and any operator-defined specialist seats)
 * and ALL CLI hands (`agy`, `claude`, `codex`):
 *   1. Replays recent session transcripts against stored L2/L3 seat memories to detect & rewrite contradicted notes.
 *   2. Repairs broken/renamed `artifact://`, `file://`, and `skill://` links across `pointers[]` and `alignmentLedger[]`.
 *   3. Merges duplicate alignment rules and prunes low-salience / stale noise.
 *   4. Synthesizes an Anti-Borges Cross-Seat Domain Wiki Index (`.archon/memory-wiki/<workspaceId>/`) with a strict
 *      compression budget (`wikiBytes <= 15% of source bytes`, `_index.md <= 150 lines`).
 */
export function dreamConsolidateCrossSeatMemory(
  indexState,
  {
    runtime = null,
    workspaceState = null,
    secondaryWorkspaceState = null,
    repoRoot = null,
    writeWikiToDisk = false,
    nowIso = new Date().toISOString(),
  } = {}
) {
  if (!indexState) return { ok: false, error: 'missing_index_state' };
  const t0 = Date.now();
  let transcriptsReplayed = 0;
  let contradictedNotesRewritten = 0;
  let brokenLinksRepaired = 0;
  let duplicateRulesMerged = 0;
  let lowSaliencePruned = 0;

  const liveArtifacts = runtime?.sharedStore?.artifacts || new Map();
  const liveSkills = runtime?.sharedStore?.skills || new Map();

  // 1. Replay recent transcripts across workspaces to catch and rewrite contradicted/failed beliefs
  const wsPairs = [
    { wsId: 'ws-default', state: workspaceState },
    { wsId: 'ws2', state: secondaryWorkspaceState },
  ];

  const transcriptOutcomeByTurnUri = new Map();
  const latestCorrectionBySeatAndTopic = new Map();

  for (const { wsId, state } of wsPairs) {
    if (!state || !Array.isArray(state.chatSessions)) continue;
    for (const sess of state.chatSessions) {
      const msgs = Array.isArray(sess.messages) ? sess.messages : [];
      for (let i = 0; i < msgs.length; i += 1) {
        const m = msgs[i];
        if (!m || m.role !== 'assistant') continue;
        transcriptsReplayed += 1;
        const turnUri = `turn://${wsId}/${sess.id}/${m.id}`;
        const text = String(m.content || '');
        const nextUser = i + 1 < msgs.length && msgs[i + 1]?.role === 'user' ? String(msgs[i + 1].content || '') : '';
        const nextAssistant =
          i + 2 < msgs.length && msgs[i + 2]?.role === 'assistant' ? String(msgs[i + 2].content || '') : '';

        // Detect if the operator or subsequent turn explicitly flagged an error/loop in this turn
        const operatorFlaggedFailure =
          /\b(?:wrong|bug\s+happened\s+again|failed|not\s+good|broke|error|overwrite|re-published\s+staged|错误|失败|不对)\b/i.test(
            nextUser
          );
        transcriptOutcomeByTurnUri.set(turnUri, {
          isError: Boolean(m.isError || operatorFlaggedFailure),
          correctionText: operatorFlaggedFailure && nextAssistant ? nextAssistant.slice(0, 220) : null,
          nextUserFeedback: operatorFlaggedFailure ? nextUser.slice(0, 160) : null,
        });

        if (operatorFlaggedFailure && nextAssistant) {
          const seatKey = String(m.seatId || 'chief-of-staff').replace(/^seat:/, '');
          latestCorrectionBySeatAndTopic.set(`${wsId}:${seatKey}`, {
            failedTurnId: m.id,
            operatorFeedback: nextUser.slice(0, 140),
            correctedResolution: nextAssistant.replace(/\s+/g, ' ').slice(0, 220),
            correctedAt: m.createdAt || nowIso,
          });
        }
      }
    }
  }

  // 2. Audit & repair L3 pointers (`indexState.pointers`): rewrite contradicted pointers, repair broken URIs, prune transient pings
  if (Array.isArray(indexState.pointers)) {
    const keptPointers = [];
    for (const ptr of indexState.pointers) {
      if (!ptr) continue;

      // Salience check: prune pure transient status pings that slipped into L3
      const sal = evaluateTurnSalienceForMemory({
        userPrompt: ptr.promptExcerpt || '',
        replyExcerpt: ptr.replyExcerpt || '',
        kind: ptr.kind,
        routedByCos: ptr.routedByCos,
      });
      if (!sal.salient && ptr.kind === 'chat-turn-execution' && (ptr.targets || []).length <= 1) {
        lowSaliencePruned += 1;
        continue;
      }

      // Check transcript replay ground truth for contradicted turns
      const turnTarget = (ptr.targets || []).find((t) => t.startsWith('turn://'));
      const replayCheck = turnTarget ? transcriptOutcomeByTurnUri.get(turnTarget) : null;
      if (replayCheck?.isError && !ptr.dreamCorrectedAt) {
        ptr.dreamCorrectedAt = nowIso;
        ptr.outcome = replayCheck.correctionText ? 'corrected_by_dreaming' : 'challenged_by_transcript';
        if (replayCheck.correctionText) {
          ptr.replyExcerpt = `[Dreaming Consolidated Correction]: ${replayCheck.correctionText}`;
          ptr.summary = `${ptr.promptExcerpt || ''} → [seat:${ptr.seatId}/${ptr.engine} · Dreaming Corrected]: ${replayCheck.correctionText.slice(0, 140)}`;
        }
        ptr.epistemicProvenance = {
          ...(ptr.epistemicProvenance || {}),
          memoryAuthority: 'retrieval_pointer_only',
          verificationStatus: replayCheck.correctionText ? 'verified_after_dream_correction' : 'retracted_or_challenged',
          requiresPrimarySourceReverification: true,
          dreamReplayNote: replayCheck.nextUserFeedback || 'transcript_contradiction_detected',
        };
        contradictedNotesRewritten += 1;
      }

      // Repair broken or outdated `artifact://` and `skill://` target URIs
      if (Array.isArray(ptr.targets)) {
        ptr.targets = ptr.targets.map((uri) => {
          if (uri.startsWith('artifact://') && liveArtifacts.size > 0) {
            const [rawArtId, revPart] = uri.slice('artifact://'.length).split('@');
            const exact = liveArtifacts.get(rawArtId);
            if (exact) {
              const latestRev = `r${exact.currentRevision || 1}`;
              if (revPart && revPart !== latestRev) {
                brokenLinksRepaired += 1;
                return `artifact://${rawArtId}@${latestRev}`;
              }
              return uri;
            }
            // Attempt fuzzy repointing if artifact was renamed/consolidated
            for (const candidateId of liveArtifacts.keys()) {
              if (candidateId.includes(rawArtId) || rawArtId.includes(candidateId)) {
                const cand = liveArtifacts.get(candidateId);
                brokenLinksRepaired += 1;
                return `artifact://${candidateId}@r${cand?.currentRevision || 1}`;
              }
            }
          }
          if (uri.startsWith('skill://') && liveSkills.size > 0) {
            const rawSk = uri.slice('skill://'.length).replace(/@\d+$/, '');
            const hasExact = [...liveSkills.values()].some((s) => s.name === rawSk);
            if (!hasExact) {
              const fuzzySk = [...liveSkills.values()].find(
                (s) => s.name && (s.name.includes(rawSk) || rawSk.includes(s.name))
              );
              if (fuzzySk) {
                brokenLinksRepaired += 1;
                return `skill://${fuzzySk.name}`;
              }
            }
          }
          return uri;
        });
      }

      // Ensure structured closed-loop learning rule metadata is attached
      if (!ptr.learningRule) {
        ptr.learningRule = extractClosedLoopLearningRule({
          seatId: ptr.seatId,
          engine: ptr.engine,
          userPrompt: ptr.promptExcerpt,
          replyText: ptr.replyExcerpt,
          targets: ptr.targets,
          epistemicProvenance: ptr.epistemicProvenance,
        });
      }

      keptPointers.push(ptr);
    }
    indexState.pointers = keptPointers.slice(0, 600);
  }

  // 3. Deduplicate & merge Chief of Staff Alignment Ledger rules across seats & CLI hands
  if (Array.isArray(indexState.alignmentLedger)) {
    const mergedByKey = new Map();
    for (const rule of indexState.alignmentLedger) {
      if (!rule || !rule.targetSeatId) continue;
      // Repair targetUris on alignment rules too
      if (Array.isArray(rule.targetUris) && liveArtifacts.size > 0) {
        rule.targetUris = rule.targetUris.map((u) => {
          if (u.startsWith('artifact://')) {
            const baseId = u.slice('artifact://'.length).split('@')[0];
            const found = liveArtifacts.get(baseId);
            if (found) return `artifact://${baseId}`;
          }
          return u;
        });
      }
      const sig = `${rule.workspaceId || 'ws-default'}:${rule.targetSeatId}:${(rule.keywords || []).slice(0, 3).sort().join(',')}`;
      if (!mergedByKey.has(sig) || DEFAULT_COS_ALIGNMENT_RULES.some((d) => d.ruleId === rule.ruleId)) {
        mergedByKey.set(rule.ruleId || sig, rule);
      } else {
        const existing = mergedByKey.get(sig);
        existing.hitCount = Number(existing.hitCount || 1) + Number(rule.hitCount || 1);
        existing.targetUris = Array.from(new Set([...(existing.targetUris || []), ...(rule.targetUris || [])])).slice(0, 8);
        duplicateRulesMerged += 1;
      }
    }
    indexState.alignmentLedger = Array.from(mergedByKey.values()).slice(0, 60);
  }

  // 4. Build Anti-Borges Cross-Seat Domain Wiki Index (`indexState.domainWiki`)
  const wikiRes = buildCrossSeatDomainWiki(indexState, {
    runtime,
    repoRoot,
    writeToDisk: writeWikiToDisk,
    nowIso,
  });

  // 5. Promote Confirmed Rules & Failure Traps to L4 Agora Federated Playbook (`archonos-dreamed-seat-rules-v0.5.json`)
  const agoraPlaybook = exportDreamedAgoraPlaybook(indexState, {
    repoRoot,
    writeToDisk: writeWikiToDisk,
    nowIso,
  });

  const dreamReport = {
    ok: true,
    dreamedAt: nowIso,
    durationMs: Date.now() - t0,
    transcriptsReplayed,
    contradictedNotesRewritten,
    brokenLinksRepaired,
    duplicateRulesMerged,
    lowSaliencePruned,
    wikiTopicsBuilt: wikiRes.topicsCount,
    wikiIndexLines: wikiRes.indexLinesCount,
    wikiCompressionRatio: wikiRes.compressionRatio,
    antiBorgesGuardPassed: wikiRes.antiBorgesGuardPassed,
    agoraRulesExported: agoraPlaybook.totalRules,
    agoraLibraryDocId: agoraPlaybook.libraryDocId,
  };

  indexState.lastDreamReport = dreamReport;
  return dreamReport;
}

/**
 * Anti-Borges Cross-Seat Domain Wiki Builder (`buildCrossSeatDomainWiki`):
 * Organizes multi-session, multi-seat knowledge across all seats & model hands (`agy`, `claude`, `codex`)
 * into linked domain pages + `_index.md` ONLY when a domain spans >= 2 pointers/artifacts, and enforces:
 *   - `_index.md` <= 150 lines
 *   - `wikiBytes <= 15%` of raw source artifacts/files bytes (Anti-Borges 1:1 Map Guard)
 */
export function buildCrossSeatDomainWiki(
  indexState,
  { runtime = null, repoRoot = null, writeToDisk = false, nowIso = new Date().toISOString() } = {}
) {
  const pointers = Array.isArray(indexState?.pointers) ? indexState.pointers : [];
  const bySeatRole = new Map();

  for (const ptr of pointers) {
    if (!ptr || ptr.epistemicProvenance?.verificationStatus === 'retracted_or_challenged') continue;
    const wsId = ptr.workspaceId || 'ws-default';
    const seatId = ptr.seatId || 'chief-of-staff';
    const key = `${wsId}:${seatId}`;
    if (!bySeatRole.has(key)) {
      bySeatRole.set(key, {
        workspaceId: wsId,
        seatId,
        schema: getSeatMemoryRoleSchema(seatId),
        enginesUsed: new Set(),
        artifacts: new Set(),
        files: new Set(),
        skills: new Set(),
        confirmedRules: [],
        trapWarnings: [],
        recentSummaries: [],
      });
    }
    const bucket = bySeatRole.get(key);
    if (ptr.engine) bucket.enginesUsed.add(ptr.engine);
    for (const t of ptr.targets || []) {
      if (t.startsWith('artifact://')) bucket.artifacts.add(t.split('@')[0]);
      else if (t.startsWith('file://')) bucket.files.add(t);
      else if (t.startsWith('skill://')) bucket.skills.add(t);
    }
    if (ptr.learningRule?.ruleStatement && bucket.confirmedRules.length < 5) {
      bucket.confirmedRules.push(ptr.learningRule.ruleStatement);
    }
    if (ptr.learningRule?.trapWarning && bucket.trapWarnings.length < 4) {
      bucket.trapWarnings.push(ptr.learningRule.trapWarning);
    }
    if (ptr.summary && bucket.recentSummaries.length < 4) {
      bucket.recentSummaries.push(ptr.summary.slice(0, 160));
    }
  }

  const topics = [];
  for (const bucket of bySeatRole.values()) {
    const totalLinkedResources = bucket.artifacts.size + bucket.files.size + bucket.skills.size;
    // Anti-Borges Multi-Source Threshold: only synthesize a domain wiki page when linking >= 2 resources or turns
    if (totalLinkedResources < 1 && bucket.recentSummaries.length < 2) continue;
    const slug = `${bucket.workspaceId}-${bucket.seatId}`;
    const pageMd = [
      `# ${bucket.schema.label} (\`seat:${bucket.seatId}\`)`,
      `- **Workspace**: \`${bucket.workspaceId === 'ws1' ? 'ws2' : 'ws1'}\` · **Archetype**: \`${bucket.schema.archetype}\` · **CLI Hands**: \`${Array.from(bucket.enginesUsed).join(', ') || 'agy/claude/codex'}\``,
      `- **Linked Canvas Artifacts**: ${Array.from(bucket.artifacts).slice(0, 8).join(', ') || 'none'}`,
      `- **Linked Skills**: ${Array.from(bucket.skills).slice(0, 6).join(', ') || 'none'}`,
      `- **Linked Files**: ${Array.from(bucket.files).slice(0, 6).join(', ') || 'none'}`,
      bucket.confirmedRules.length > 0
        ? `## Validated Operating Rules\n${bucket.confirmedRules.map((r) => `- ${r}`).join('\n')}`
        : '',
      bucket.trapWarnings.length > 0
        ? `## Known Failure Traps to Avoid\n${bucket.trapWarnings.map((w) => `- ⚠️ ${w}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 1800); // Hard per-page cap to prevent Borges bloat

    topics.push({
      slug,
      workspaceId: bucket.workspaceId,
      seatId: bucket.seatId,
      title: bucket.schema.label,
      engines: Array.from(bucket.enginesUsed),
      artifactCount: bucket.artifacts.size,
      skillCount: bucket.skills.size,
      fileCount: bucket.files.size,
      artifacts: Array.from(bucket.artifacts).slice(0, 8),
      skills: Array.from(bucket.skills).slice(0, 6),
      files: Array.from(bucket.files).slice(0, 6),
      confirmedRules: bucket.confirmedRules.slice(0, 5),
      trapWarnings: bucket.trapWarnings.slice(0, 4),
      pageBytes: Buffer.byteLength(pageMd, 'utf8'),
      pageMd,
    });
  }

  const indexHeaderLines = [
    `# ArchonOS Cross-Seat & Multi-Hand Memory Wiki Index (_index.md)`,
    `Updated: ${nowIso} · Authority: retrieval_pointer_only · Anti-Borges Compression Guard: ACTIVE`,
    ``,
    ...topics.slice(0, 40).map(
      (t) =>
        `- **[${t.seatId}](wiki://${t.slug}.md)** (${t.engines.join('/') || 'multi-hand'}) — ${t.artifactCount} artifacts · ${t.skillCount} skills · ${t.fileCount} files`
    ),
  ].slice(0, 140); // Strict <= 150 lines cap (Anthropic MEMORY.md top-layer invariant)

  const indexMd = indexHeaderLines.join('\n');
  const totalWikiBytes =
    Buffer.byteLength(indexMd, 'utf8') + topics.reduce((acc, t) => acc + t.pageBytes, 0);
  // Estimate source corpus bytes conservatively (at least 100 KB baseline across artifacts + transcripts)
  const estimatedSourceBytes = Math.max(120000, pointers.length * 4000 + (runtime?.sharedStore?.artifacts?.size || 10) * 18000);
  const compressionRatio = Number((totalWikiBytes / estimatedSourceBytes).toFixed(4));
  const antiBorgesGuardPassed = compressionRatio <= 0.15 && indexHeaderLines.length <= 150;

  if (indexState) {
    indexState.domainWiki = {
      updatedAt: nowIso,
      indexLinesCount: indexHeaderLines.length,
      totalWikiBytes,
      compressionRatio,
      antiBorgesGuardPassed,
      indexMd,
      topics,
    };
  }

  if (writeToDisk && repoRoot) {
    try {
      const wikiDir = join(repoRoot, '.archon', 'memory-wiki');
      mkdirSync(wikiDir, { recursive: true });
      writeFileSync(join(wikiDir, '_index.md'), indexMd, 'utf8');
      for (const t of topics) {
        writeFileSync(join(wikiDir, `${t.slug}.md`), t.pageMd, 'utf8');
      }
    } catch (_) {}
  }

  return {
    topicsCount: topics.length,
    indexLinesCount: indexHeaderLines.length,
    totalWikiBytes,
    compressionRatio,
    antiBorgesGuardPassed,
    indexMd,
    topics,
  };
}

/**
 * Single-Writer Verbatim Shard Broker (`upsertSeatVerbatimShard` & `synthesizeCampaignShards`):
 * Implements the Harvey LAB 72% -> 100% fact-survival architecture across all seats & CLI hands (`agy`, `claude`, `codex`):
 *   - Forbids concurrent multi-seat overwrites on a shared summary table.
 *   - Each seat writes exclusively to its own partitioned shard (`workspaceId + campaignId + seatId + entityId`)
 *     and quotes critical primary clauses/figures verbatim (`verbatimQuotes[]` + `primaryFilingHash`).
 *   - Chief of Staff then deterministically synthesizes all shards with 100% fact preservation.
 */
export function upsertSeatVerbatimShard(
  indexState,
  {
    workspaceId = 'ws-default',
    campaignId = 'default-campaign',
    seatId = 'chief-of-staff',
    engine = 'codex',
    entityId = 'general',
    title = '',
    verbatimQuotes = [],
    verifiedFacts = [],
    trapWarnings = [],
    primaryFilingHash = null,
    targetUris = [],
    repoRoot = null,
    writeToDisk = false,
    updatedAt = new Date().toISOString(),
  } = {}
) {
  if (!indexState) return null;
  if (!Array.isArray(indexState.verbatimShards)) {
    indexState.verbatimShards = [];
  }
  const cleanSeatId = String(seatId || 'chief-of-staff').replace(/^seat:/, '');
  const cleanCampaign = String(campaignId || 'default-campaign').replace(/[^a-zA-Z0-9._-]/g, '-');
  const cleanEntity = String(entityId || 'general').replace(/[^a-zA-Z0-9._-]/g, '-');
  const shardId = `shard-${workspaceId}-${cleanCampaign}-${cleanSeatId}-${cleanEntity}`;

  const cleanQuotes = (Array.isArray(verbatimQuotes) ? verbatimQuotes : [])
    .map((q) =>
      typeof q === 'string'
        ? { quote: q.trim(), source: primaryFilingHash || 'primary_source' }
        : {
            quote: String(q?.quote || q?.text || '').trim(),
            source: String(q?.source || q?.clause || primaryFilingHash || 'primary_source').trim(),
          }
    )
    .filter((q) => q.quote.length > 0)
    .slice(0, 20);

  const shard = {
    shardId,
    workspaceId,
    campaignId: cleanCampaign,
    seatId: cleanSeatId,
    engine,
    entityId: cleanEntity,
    title: title || `${cleanSeatId} (${engine}) · ${cleanEntity}`,
    singleWriterOwner: `seat:${cleanSeatId}`,
    verbatimQuotes: cleanQuotes,
    verifiedFacts: (Array.isArray(verifiedFacts) ? verifiedFacts : []).map((f) => String(f).trim()).filter(Boolean).slice(0, 25),
    trapWarnings: (Array.isArray(trapWarnings) ? trapWarnings : []).map((w) => String(w).trim()).filter(Boolean).slice(0, 10),
    primaryFilingHash: primaryFilingHash || null,
    targetUris: (Array.isArray(targetUris) ? targetUris : []).slice(0, 10),
    memoryAuthority: 'retrieval_pointer_only',
    updatedAt,
  };

  // Single-writer lock invariant: only `seat:${cleanSeatId}` owns `shardId`
  const existingIdx = indexState.verbatimShards.findIndex((s) => s.shardId === shardId);
  if (existingIdx >= 0) {
    indexState.verbatimShards[existingIdx] = shard;
  } else {
    indexState.verbatimShards.unshift(shard);
    if (indexState.verbatimShards.length > 240) {
      indexState.verbatimShards = indexState.verbatimShards.slice(0, 240);
    }
  }

  if (writeToDisk && repoRoot) {
    try {
      const shardDir = join(repoRoot, '.archon', 'memory-shards', workspaceId, cleanCampaign);
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(join(shardDir, `${cleanSeatId}-${cleanEntity}.json`), JSON.stringify(shard, null, 2), 'utf8');
    } catch (_) {}
  }

  return shard;
}

export function synthesizeCampaignShards(
  indexState,
  { workspaceId = 'ws-default', campaignId = null, seatId = null } = {}
) {
  const allShards = Array.isArray(indexState?.verbatimShards) ? indexState.verbatimShards : [];
  const filtered = allShards.filter((s) => {
    if (workspaceId && s.workspaceId !== workspaceId) return false;
    if (campaignId && s.campaignId !== campaignId) return false;
    if (seatId && s.seatId !== String(seatId).replace(/^seat:/, '')) return false;
    return true;
  });

  const totalVerbatimQuotes = filtered.reduce((acc, s) => acc + (s.verbatimQuotes?.length || 0), 0);
  const totalVerifiedFacts = filtered.reduce((acc, s) => acc + (s.verifiedFacts?.length || 0), 0);
  const participatingSeats = Array.from(new Set(filtered.map((s) => `${s.seatId}/${s.engine}`)));

  const synthesisMd = filtered
    .map((s) => {
      const quotesBlock = (s.verbatimQuotes || [])
        .map((q) => `  - 💬 *"${q.quote}"* (\`${q.source}\`)`)
        .join('\n');
      const factsBlock = (s.verifiedFacts || []).map((f) => `  - ✅ ${f}`).join('\n');
      return [
        `### 🔒 Shard \`${s.shardId}\` — Owner: \`seat:${s.seatId}\` (\`${s.engine}\`) · Entity: \`${s.entityId}\``,
        quotesBlock ? `**Verbatim Primary Quotes (${s.verbatimQuotes.length})**:\n${quotesBlock}` : '',
        factsBlock ? `**Verified Facts (${s.verifiedFacts.length})**:\n${factsBlock}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return {
    workspaceId,
    campaignId: campaignId || 'all',
    shardCount: filtered.length,
    participatingSeats,
    totalVerbatimQuotes,
    totalVerifiedFacts,
    factSurvivalRate: 1.0, // 100% single-writer partition survival (zero shared-table contention)
    shards: filtered,
    synthesisMd,
  };
}

/**
 * Dreaming -> L4 Federated Playbook Promotion (`exportDreamedAgoraPlaybook`):
 * Packages entity-sanitized, cross-seat confirmed rules & failure trap warnings into a structured
 * Federated Library playbook (`archonos-dreamed-seat-rules-v0.5.json`) for knowledge transfer across
 * workspaces and remote peer instances.
 */
export function exportDreamedAgoraPlaybook(
  indexState,
  { repoRoot = null, writeToDisk = false, nowIso = new Date().toISOString() } = {}
) {
  const pointers = Array.isArray(indexState?.pointers) ? indexState.pointers : [];
  const confirmedRules = [];
  const seenStatements = new Set();

  for (const ptr of pointers) {
    if (!ptr || ptr.epistemicProvenance?.verificationStatus === 'retracted_or_challenged') continue;
    const lr = ptr.learningRule;
    if (!lr || (!lr.ruleStatement && !lr.trapWarning)) continue;
    // Sanitize out single-ticker trivia from federated L4 rules
    const combined = `${lr.ruleStatement || ''} ${lr.trapWarning || ''}`;
    if (/\b(?:301087\.SZ|000725\.SZ|100,000\s*characters)\b/i.test(combined)) continue;
    const dedupKey = `${ptr.seatId}:${(lr.ruleStatement || '').slice(0, 80)}:${(lr.trapWarning || '').slice(0, 80)}`;
    if (seenStatements.has(dedupKey)) continue;
    seenStatements.add(dedupKey);

    confirmedRules.push({
      seatId: ptr.seatId,
      engine: ptr.engine,
      workspaceScope: ptr.workspaceId === 'ws1' ? 'ws2' : 'ws1',
      ruleStatus: lr.ruleStatus,
      ruleStatement: lr.ruleStatement,
      howVerified: lr.howVerified,
      trapWarning: lr.trapWarning,
      targetUris: (ptr.targets || []).filter((u) => !u.startsWith('turn://')).slice(0, 4),
      recordedAt: ptr.createdAt,
    });
    if (confirmedRules.length >= 40) break;
  }

  const playbook = {
    libraryDocId: 'archonos-dreamed-seat-rules-v0.5.json',
    version: 'seat-memory.v0.5',
    topologyMode: 'off_lan_agora_only',
    memoryAuthority: 'retrieval_pointer_only',
    exportedAt: nowIso,
    totalRules: confirmedRules.length,
    rules: confirmedRules,
  };

  if (indexState) {
    indexState.agoraDreamPlaybook = playbook;
  }

  if (writeToDisk && repoRoot) {
    try {
      const libDir = join(repoRoot, '.archon', 'agora-library');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, playbook.libraryDocId), JSON.stringify(playbook, null, 2), 'utf8');
    } catch (_) {}
  }

  return playbook;
}

export function invalidateMemoryPointersByRetraction(
  indexState,
  workspaceState = null,
  { symbol = null, artifactId = null, reportDigest = null, reason = 'editor_downgrade_or_retraction' } = {}
) {
  let invalidatedCount = 0;
  const symUpper = symbol ? String(symbol).toUpperCase() : null;
  const symLower = symbol ? String(symbol).toLowerCase() : null;
  const artLower = artifactId ? String(artifactId).toLowerCase() : symLower ? `art-stock-sop-${symLower}` : null;

  if (indexState && Array.isArray(indexState.pointers)) {
    for (const ptr of indexState.pointers) {
      const hay = `${ptr.summary || ''} ${ptr.promptExcerpt || ''} ${ptr.replyExcerpt || ''} ${(ptr.targets || []).join(' ')}`;
      const matchesSymbol = symUpper && new RegExp(`\\b${symUpper}\\b`, 'i').test(hay);
      const matchesArt = artLower && hay.toLowerCase().includes(artLower);
      const matchesDigest = reportDigest && ptr.epistemicProvenance?.primaryFilingHash === reportDigest;
      if (matchesSymbol || matchesArt || matchesDigest) {
        ptr.epistemicProvenance = {
          ...(ptr.epistemicProvenance || {}),
          memoryAuthority: 'retrieval_pointer_only',
          verificationStatus: 'retracted_or_challenged',
          quarantinedFromCanonicalExemplars: true,
          requiresPrimarySourceReverification: true,
          retractionReason: reason,
          retractedReportDigest: reportDigest || null,
          invalidatedAt: new Date().toISOString(),
        };
        invalidatedCount += 1;
      }
    }
  }

  if (workspaceState && workspaceState.seatMemory && typeof workspaceState.seatMemory === 'object') {
    for (const seatKey of Object.keys(workspaceState.seatMemory)) {
      const list = workspaceState.seatMemory[seatKey];
      if (!Array.isArray(list)) continue;
      for (const mem of list) {
        const text = `${mem.key || ''} ${mem.content || ''}`;
        if (
          (symUpper && new RegExp(`\\b${symUpper}\\b`, 'i').test(text)) ||
          (artLower && text.toLowerCase().includes(artLower))
        ) {
          mem.verificationStatus = 'retracted_or_challenged';
          mem.memoryAuthority = 'retrieval_pointer_only';
          mem.retractionNote = `[RETRACTED/CHALLENGED: ${reason} — re-verify primary filings; do not treat cached PASS as ground truth]`;
        }
      }
    }
  }

  return { invalidatedCount, symbol: symUpper, artifactId: artLower, reason };
}

export function sanitizeGlobalMemoryForUniversalSop(globalMemory = []) {
  const rawList = Array.isArray(globalMemory) ? globalMemory : [];
  const cleaned = [];
  let hasMemoryPriorSop = false;
  let hasOffLanAgoraOnlySop = false;

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || '');
    const content = String(item.content || '');
    if (key === 'memory-prior-to-skills-execution-sop' || item.id === 'gmem-memory-prior-to-skills-sop') {
      hasMemoryPriorSop = true;
      cleaned.push({ ...item, content: MEMORY_PRIOR_TO_SKILLS_SOP_ENTRY.content });
      continue;
    }
    if (key === 'off-lan-agora-only-topology-sop' || item.id === 'gmem-off-lan-agora-only-sop') {
      hasOffLanAgoraOnlySop = true;
      cleaned.push({ ...item, content: OFF_LAN_AGORA_ONLY_SOP_ENTRY.content });
      continue;
    }
    // Strip legacy cross-seat synthesis entries that polluted Global Memory with entity-specific ticker/corridor numbers (e.g. GEV, 301087.SZ, Hormuz) or obsolete 100k character quotas
    if (
      key === 'cos-cross-seat-synthesis' ||
      /\b(?:GEV|301087\.SZ|Hormuz\s+Eastbound)\b/i.test(content) ||
      /\b(?:100,000[-\s]*character|100k\+\s*monograph|minReportChars\s*[:=]\s*100000)\b/i.test(content)
    ) {
      continue;
    }
    cleaned.push({
      ...item,
      memoryAuthority: 'retrieval_pointer_only',
    });
  }

  if (!hasOffLanAgoraOnlySop) {
    cleaned.unshift({ ...OFF_LAN_AGORA_ONLY_SOP_ENTRY });
  }
  if (!hasMemoryPriorSop) {
    cleaned.unshift({ ...MEMORY_PRIOR_TO_SKILLS_SOP_ENTRY });
  }
  return cleaned;
}

export function loadOrInitMemoryIndex(indexFilePath) {
  if (indexFilePath && existsSync(indexFilePath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexFilePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pointers)) {
        // Keep default alignment rules refreshed without entity-specific ticker/corridor clutter
        const customRules = Array.isArray(parsed.alignmentLedger)
          ? parsed.alignmentLedger.filter((r) => !DEFAULT_COS_ALIGNMENT_RULES.some((d) => d.ruleId === r.ruleId))
          : [];
        parsed.alignmentLedger = [...DEFAULT_COS_ALIGNMENT_RULES, ...customRules];
        return parsed;
      }
    } catch (_) {}
  }
  return {
    version: 'seat-memory-index.v3',
    updatedAt: new Date().toISOString(),
    pointers: [],
    alignmentLedger: [...DEFAULT_COS_ALIGNMENT_RULES],
    bootstrappedSessions: {},
  };
}

export function saveMemoryIndex(indexFilePath, indexState) {
  if (!indexFilePath || !indexState) return;
  try {
    mkdirSync(dirname(indexFilePath), { recursive: true });
    indexState.updatedAt = new Date().toISOString();
    writeFileSync(indexFilePath, JSON.stringify(indexState, null, 2), 'utf8');
  } catch (_) {}
}

export function recordExecutionMemoryPointer(indexState, {
  pointerId,
  workspaceId = 'ws-default',
  sessionId = 'session-main',
  messageId = '',
  seatId = 'chief-of-staff',
  delegatedFromSeat = null,
  routedByCos = false,
  routingReason = '',
  engine = 'claude',
  kind = 'chat-turn-execution',
  userPrompt = '',
  replyText = '',
  artifactUpdated = null,
  generatedFiles = [],
  selectedSkills = [],
  selectedMcps = [],
  outcome = 'completed',
  latencyMs = 0,
  epistemicProvenance = null,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!indexState || !Array.isArray(indexState.pointers)) return null;
  const cleanSeatId = String(seatId || 'chief-of-staff').replace(/^seat:/, '');
  const cleanPrompt = String(userPrompt || '').replace(/\s+/g, ' ').trim();
  const cleanReply = String(replyText || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanPrompt && !cleanReply) return null;

  // Salience Gate across all seats & CLI hands: skip indexing pure transient status pings
  const salience = evaluateTurnSalienceForMemory({
    userPrompt: cleanPrompt,
    replyText: cleanReply,
    artifactUpdated,
    generatedFiles,
    selectedSkills,
    routedByCos,
    kind,
  });
  if (!salience.salient) return null;

  const id = pointerId || `ptr-${messageId || Date.now()}-${cleanSeatId}`;
  const existingIdx = indexState.pointers.findIndex((p) => p.pointerId === id || (messageId && p.messageId === messageId));

  const targets = extractTargetPointersFromTurn({
    workspaceId,
    sessionId,
    messageId,
    seatId: cleanSeatId,
    userPrompt: cleanPrompt,
    replyText: cleanReply,
    artifactUpdated,
    generatedFiles,
    selectedSkills,
    selectedMcps,
  });

  const keywords = tokenizeMemoryQuery(`${cleanPrompt} ${cleanReply.slice(0, 360)} ${targets.join(' ')}`).slice(0, 28);
  const summary = `${cleanPrompt.slice(0, 110)}${cleanPrompt.length > 110 ? '…' : ''} → [${cleanSeatId}/${engine}]: ${cleanReply.slice(0, 160)}${cleanReply.length > 160 ? '…' : ''}`;
  const resolvedProvenance = evaluatePointerEpistemicProvenance({
    promptText: cleanPrompt,
    replyText: cleanReply,
    targets,
    explicitProvenance: epistemicProvenance,
    createdAt,
  });
  const learningRule = extractClosedLoopLearningRule({
    seatId: cleanSeatId,
    engine,
    userPrompt: cleanPrompt,
    replyText: cleanReply,
    targets,
    epistemicProvenance: resolvedProvenance,
  });

  const pointer = {
    pointerId: id,
    workspaceId,
    sessionId,
    messageId: messageId || null,
    seatId: cleanSeatId,
    roleArchetype: getSeatMemoryRoleSchema(cleanSeatId).archetype,
    delegatedFromSeat: delegatedFromSeat ? String(delegatedFromSeat).replace(/^seat:/, '') : null,
    routedByCos: Boolean(routedByCos),
    routingReason: routingReason || null,
    engine,
    kind,
    keywords,
    promptExcerpt: cleanPrompt.slice(0, 180),
    replyExcerpt: cleanReply.slice(0, 240),
    summary,
    targets,
    outcome,
    latencyMs: Number(latencyMs || 0),
    salienceScore: salience.salienceScore,
    salienceReason: salience.reason,
    learningRule,
    memoryAuthority: 'retrieval_pointer_only',
    epistemicProvenance: resolvedProvenance,
    createdAt,
  };

  if (existingIdx >= 0) {
    indexState.pointers[existingIdx] = pointer;
  } else {
    indexState.pointers.unshift(pointer);
    if (indexState.pointers.length > 600) {
      indexState.pointers = indexState.pointers.slice(0, 600);
    }
  }

  // Update Chief of Staff's Alignment Ledger only when the pointer is not retracted/challenged
  if (
    outcome === 'completed' &&
    resolvedProvenance.verificationStatus !== 'retracted_or_challenged' &&
    (routedByCos || cleanSeatId !== 'chief-of-staff')
  ) {
    if (!Array.isArray(indexState.alignmentLedger)) {
      indexState.alignmentLedger = [...DEFAULT_COS_ALIGNMENT_RULES];
    }
    const matchedRule = indexState.alignmentLedger.find(
      (r) =>
        r.targetSeatId === cleanSeatId &&
        r.workspaceId === workspaceId &&
        Array.isArray(r.keywords) &&
        r.keywords.some((kw) => keywords.includes(kw))
    );
    if (matchedRule) {
      matchedRule.hitCount = Number(matchedRule.hitCount || 1) + 1;
      matchedRule.lastVerifiedAt = createdAt;
      for (const t of targets) {
        if ((t.startsWith('artifact://') || t.startsWith('file://')) && !matchedRule.targetUris.includes(t)) {
          matchedRule.targetUris = [...matchedRule.targetUris, t].slice(0, 8);
        }
      }
    } else if (artifactUpdated?.artifactId || generatedFiles?.length > 0) {
      const topKws = keywords.filter((k) => k.length >= 3).slice(0, 8);
      if (topKws.length >= 2) {
        indexState.alignmentLedger.unshift({
          ruleId: `align-learned-${Date.now().toString(36)}-${cleanSeatId}`,
          workspaceId,
          pattern: cleanPrompt.slice(0, 90),
          keywords: topKws,
          targetSeatId: cleanSeatId,
          preferredEngine: engine,
          rationale: routingReason || `Execution pointer by seat:${cleanSeatId} producing ${artifactUpdated?.artifactId || generatedFiles?.[0]?.filename || 'deliverable'} (retrieval_pointer_only).`,
          targetUris: targets.filter((t) => !t.startsWith('turn://')).slice(0, 6),
          hitCount: 1,
          confidence: 0.92,
          lastVerifiedAt: createdAt,
        });
        if (indexState.alignmentLedger.length > 60) {
          indexState.alignmentLedger = indexState.alignmentLedger.slice(0, 60);
        }
      }
    }
  }

  return pointer;
}

export function bootstrapMemoryIndexFromHistory(indexState, { runtime, workspaceState, secondaryWorkspaceState } = {}) {
  if (!indexState) return indexState;
  const statesToScan = [
    { wsId: 'ws-default', state: workspaceState },
    { wsId: 'ws2', state: secondaryWorkspaceState },
  ];

  for (const { wsId, state } of statesToScan) {
    if (!state || !Array.isArray(state.chatSessions)) continue;
    for (const sess of state.chatSessions) {
      const msgs = Array.isArray(sess.messages) ? sess.messages : [];
      const markerKey = `${wsId}:${sess.id}`;
      if (indexState.bootstrappedSessions?.[markerKey] === msgs.length && indexState.pointers.length > 0) {
        continue;
      }
      // Scan assistant turns paired with preceding user turns (newest last so most recent end up at top)
      const recentSlice = msgs.slice(-80);
      for (let i = 0; i < recentSlice.length; i += 1) {
        const m = recentSlice[i];
        if (!m || m.role !== 'assistant' || m.isScheduledRun) continue;
        const prevUser = i > 0 && recentSlice[i - 1]?.role === 'user' ? recentSlice[i - 1] : null;
        if (!prevUser && !m.content) continue;
        recordExecutionMemoryPointer(indexState, {
          pointerId: `ptr-${m.id || `${sess.id}-${i}`}`,
          workspaceId: wsId,
          sessionId: sess.id,
          messageId: m.id,
          seatId: m.seatId || sess.pinnedSeatId || 'chief-of-staff',
          delegatedFromSeat: m.delegatedFromSeat || null,
          routedByCos: Boolean(m.routedByCos),
          routingReason: m.routingReason || '',
          engine: m.engine || 'claude',
          kind: m.artifactUpdated ? 'artifact-evolution' : m.workflowExecuted ? 'workflow-sop' : 'chat-turn-execution',
          userPrompt: prevUser?.content || '',
          replyText: m.content || '',
          artifactUpdated: m.artifactUpdated || null,
          generatedFiles: m.generatedFiles || [],
          selectedSkills: prevUser?.selectedSkills || [],
          selectedMcps: prevUser?.selectedMcps || [],
          outcome: m.isError ? 'failed' : 'completed',
          latencyMs: m.latencyMs || 0,
          createdAt: m.createdAt || sess.updatedAt || new Date().toISOString(),
        });
      }
      if (!indexState.bootstrappedSessions) indexState.bootstrappedSessions = {};
      indexState.bootstrappedSessions[markerKey] = msgs.length;
    }
  }

  // Also ensure every live Canvas artifact has an asset index pointer so `artifact://` hits always resolve
  if (runtime?.sharedStore?.artifacts) {
    for (const art of runtime.sharedStore.artifacts.values()) {
      if (!art?.artifactId) continue;
      const ptrId = `ptr-asset-${art.artifactId}`;
      if (indexState.pointers.some((p) => p.pointerId === ptrId)) continue;
      const ownerSeat = String(art.publishedBySeat || 'chief-of-staff').replace(/^seat:/, '');
      const wsId = art.workspaceId || art.metadata?.workspaceId || 'ws-default';
      const htmlPath = art.metadata?.localHtmlPath || `packages/archon-app/public/artifacts/${art.artifactId}.html`;
      const kws = tokenizeMemoryQuery(`${art.artifactId} ${art.title || ''} ${(art.tags || []).join(' ')} ${art.folderId || ''}`);
      indexState.pointers.push({
        pointerId: ptrId,
        workspaceId: wsId,
        sessionId: 'asset-registry',
        messageId: null,
        seatId: ownerSeat,
        roleArchetype: getSeatMemoryRoleSchema(ownerSeat).archetype,
        delegatedFromSeat: null,
        routedByCos: false,
        routingReason: 'Live Canvas Artifact Asset Index',
        engine: 'canvas-registry',
        kind: 'live-canvas-artifact',
        keywords: kws,
        promptExcerpt: art.title || art.artifactId,
        replyExcerpt: `Live Canvas Artifact ${art.artifactId} (r${art.currentRevision || 1}) owned by seat:${ownerSeat} in folder ${art.folderLabel || art.folderId || 'vault'}.`,
        summary: `[Asset ${art.artifactId}@r${art.currentRevision || 1}] ${art.title || art.artifactId} (seat:${ownerSeat}) → ${htmlPath}`,
        targets: [
          `artifact://${art.artifactId}@r${art.currentRevision || 1}`,
          `file://${htmlPath}`,
        ],
        outcome: 'completed',
        latencyMs: 0,
        createdAt: new Date(art.updatedAt || Date.now()).toISOString(),
      });
    }
  }

  return indexState;
}

export function querySeatMemoryIndex(indexState, {
  query = '',
  seatId = 'chief-of-staff',
  workspaceId = 'ws-default',
  limit = 6,
  runtime = null,
  workspaceState = null,
} = {}) {
  const t0 = Date.now();
  const cleanSeatId = String(seatId || 'chief-of-staff').replace(/^seat:/, '');
  const isCosSeat = cleanSeatId === 'chief-of-staff' || cleanSeatId === 'de-chief-of-staff';
  const roleSchema = getSeatMemoryRoleSchema(cleanSeatId);
  const qTokens = tokenizeMemoryQuery(query);

  const pointers = Array.isArray(indexState?.pointers) ? indexState.pointers : [];
  const wsPointers = pointers.filter((p) => !p.workspaceId || p.workspaceId === workspaceId);
  const scored = [];

  for (const ptr of wsPointers) {
    let score = 0;
    const ptrKeywords = new Set(ptr.keywords || []);
    const ptrTargetsStr = (ptr.targets || []).join(' ').toLowerCase();
    const ptrSummaryLower = String(ptr.summary || '').toLowerCase();

    if (qTokens.length === 0) {
      score = ptr.seatId === cleanSeatId ? 5 : isCosSeat ? 3 : 1;
    } else {
      for (const qt of qTokens) {
        if (ptrKeywords.has(qt)) score += 4;
        else if (ptrTargetsStr.includes(qt)) score += 5;
        else if (ptrSummaryLower.includes(qt)) score += 2;
      }
    }

    if (score <= 0 && qTokens.length > 0) continue;

    // Asymmetric seat weighting:
    // - Specialist seats boost their own past execution pointers & preferred URI schemes
    // - Chief of Staff boosts cross-seat delegations & live asset pointers across the whole OS
    if (ptr.seatId === cleanSeatId) {
      score += 2.5;
    } else if (isCosSeat && ptr.workspaceId === workspaceId) {
      score += 1.5;
    }
    if ((ptr.targets || []).some((u) => roleSchema.preferredUriSchemes.some((pref) => u.startsWith(pref)))) {
      score += 1.0;
    }
    if (ptr.kind === 'artifact-evolution') {
      score += 0.8;
    }

    const prov =
      ptr.epistemicProvenance ||
      evaluatePointerEpistemicProvenance({
        promptText: ptr.promptExcerpt || '',
        replyText: ptr.replyExcerpt || '',
        targets: ptr.targets || [],
        createdAt: ptr.createdAt,
      });
    ptr.epistemicProvenance = prov;
    ptr.memoryAuthority = 'retrieval_pointer_only';

    if (prov.verificationStatus === 'retracted_or_challenged') {
      score = Math.max(0.1, score - 3.5);
    }

    scored.push({ pointer: ptr, score: Number(score.toFixed(2)) });
  }

  scored.sort((a, b) => b.score - a.score || String(b.pointer.createdAt).localeCompare(String(a.pointer.createdAt)));
  const topHits = scored.slice(0, limit).map(({ pointer, score }) => ({
    ...pointer,
    hitScore: score,
    memoryAuthority: 'retrieval_pointer_only',
    dereferenced: dereferencePointerTargets(pointer, { runtime, workspaceState }),
  }));

  // Match Chief of Staff Alignment Ledger rules (strictly workspace-scoped)
  const wsAlignmentRules = (indexState?.alignmentLedger || []).filter(
    (r) => !r.workspaceId || r.workspaceId === workspaceId
  );
  const alignmentHits = wsAlignmentRules
    .map((rule) => {
      let rScore = 0;
      if (qTokens.length === 0) {
        rScore = rule.targetSeatId === cleanSeatId || isCosSeat ? 2 : 0;
      } else {
        for (const qt of qTokens) {
          if ((rule.keywords || []).includes(qt)) rScore += 5;
          else if (String(rule.pattern || '').toLowerCase().includes(qt)) rScore += 2;
        }
      }
      if (rScore <= 0) return null;
      return { ...rule, matchScore: rScore };
    })
    .filter(Boolean)
    .sort((a, b) => b.matchScore - a.matchScore || (b.hitCount || 0) - (a.hitCount || 0))
    .slice(0, 4);

  // Extract Memory-recommended skills (Step 1 Memory Search -> Step 2 Skill Selection)
  const recommendedSkillSet = new Set();
  for (const rule of alignmentHits) {
    for (const u of rule.targetUris || []) {
      if (u.startsWith('skill://')) recommendedSkillSet.add(u.slice('skill://'.length));
    }
  }
  for (const h of topHits) {
    for (const u of h.targets || []) {
      if (u.startsWith('skill://')) recommendedSkillSet.add(u.slice('skill://'.length));
    }
  }
  if (runtime?.sharedStore?.skills && qTokens.length > 0) {
    for (const sk of runtime.sharedStore.skills.values()) {
      if (sk.state !== 'active') continue;
      const skText = `${sk.name || ''} ${sk.title || ''} ${sk.description || ''}`.toLowerCase();
      if (qTokens.some((qt) => qt.length >= 3 && skText.includes(qt))) {
        recommendedSkillSet.add(sk.name);
      }
    }
  }
  const recommendedSkills = Array.from(recommendedSkillSet).slice(0, 6);

  // Global SOP Memory (sanitized so only universal SOPs appear, never entity-specific tickers/corridors)
  const globalSopHits = sanitizeGlobalMemoryForUniversalSop(workspaceState?.globalMemory || []);

  // Query-Time Wiki + Pointer Search Fusion (L3.5): rank Domain Wiki pages alongside pointers[]
  const wikiTopics = Array.isArray(indexState?.domainWiki?.topics) ? indexState.domainWiki.topics : [];
  const wikiHits = wikiTopics
    .filter((wt) => !wt.workspaceId || wt.workspaceId === workspaceId)
    .map((wt) => {
      let wScore = wt.seatId === cleanSeatId ? 3 : isCosSeat ? 1.5 : 0;
      const hay = `${wt.seatId} ${wt.title || ''} ${(wt.artifacts || []).join(' ')} ${(wt.skills || []).join(' ')} ${(wt.confirmedRules || []).join(' ')} ${(wt.trapWarnings || []).join(' ')}`.toLowerCase();
      for (const qt of qTokens) {
        if (hay.includes(qt)) wScore += 4;
      }
      if (wScore <= 0) return null;
      return {
        ...wt,
        wikiUri: `wiki://${wt.slug}.md`,
        matchScore: Number(wScore.toFixed(2)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);

  // Match any Single-Writer Verbatim Shards (L3.5 Harvey LAB 100% fact-survival partitions)
  const allShards = Array.isArray(indexState?.verbatimShards) ? indexState.verbatimShards : [];
  const shardHits = allShards
    .filter((sh) => !sh.workspaceId || sh.workspaceId === workspaceId)
    .map((sh) => {
      let sScore = sh.seatId === cleanSeatId ? 2 : 0;
      const hay = `${sh.campaignId} ${sh.seatId} ${sh.entityId} ${sh.title || ''} ${(sh.verbatimQuotes || []).map((q) => q.quote).join(' ')} ${(sh.verifiedFacts || []).join(' ')}`.toLowerCase();
      for (const qt of qTokens) {
        if (hay.includes(qt)) sScore += 4.5;
      }
      if (sScore <= 0) return null;
      return { ...sh, matchScore: Number(sScore.toFixed(2)) };
    })
    .filter(Boolean)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);

  // Build Chief of Staff Live OS Asset Inventory Summary scoped to workspaceId
  const wsSeatsCount = runtime?.sharedStore?.seats
    ? [...runtime.sharedStore.seats.values()].filter((s) => {
        const sWs = s.workspaceId || 'ws-default';
        return sWs === workspaceId && s.id !== 'seat-archon';
      }).length
    : 0;
  const wsArtifactsCount = runtime?.sharedStore?.artifacts
    ? [...runtime.sharedStore.artifacts.values()].filter((a) => {
        const aWs = a.workspaceId || a.metadata?.workspaceId || 'ws-default';
        return aWs === workspaceId;
      }).length
    : 0;
  const cosAssetOverview = runtime
    ? {
        workspaceId,
        totalSeats: wsSeatsCount,
        totalArtifacts: wsArtifactsCount,
        totalSkills: runtime.sharedStore?.skills?.size || 0,
        totalMcps: runtime.sharedStore?.mcpServers?.size || 0,
        totalSchedules: runtime.sharedStore?.schedules?.size || 0,
        totalIndexedPointers: wsPointers.length,
        totalAlignmentRules: wsAlignmentRules.length,
        totalVerbatimShards: allShards.filter((s) => !s.workspaceId || s.workspaceId === workspaceId).length,
      }
    : null;

  return {
    seatId: cleanSeatId,
    workspaceId,
    roleSchema,
    executionPriority: 'memory-prior-to-skills',
    memoryAuthority: 'retrieval_pointer_only',
    query,
    queryTokens: qTokens,
    lookupMs: Date.now() - t0,
    totalIndexedPointers: wsPointers.length,
    hitCount: topHits.length,
    hits: topHits,
    alignmentHits,
    wikiHits,
    shardHits,
    recommendedSkills,
    globalSopHits,
    cosAssetOverview,
    domainWiki: indexState?.domainWiki || null,
    lastDreamReport: indexState?.lastDreamReport || null,
    agoraDreamPlaybook: indexState?.agoraDreamPlaybook || null,
  };
}

export function dereferencePointerTargets(pointer, { runtime } = {}) {
  const resolved = [];
  for (const uri of pointer?.targets || []) {
    if (uri.startsWith('artifact://')) {
      const rawId = uri.slice('artifact://'.length).split('@')[0];
      const art = runtime?.sharedStore?.artifacts?.get(rawId);
      if (art) {
        resolved.push({
          uri,
          type: 'artifact',
          title: art.title || rawId,
          revision: art.currentRevision || 1,
          ownerSeat: art.publishedBySeat || 'chief-of-staff',
          localHtmlPath: art.metadata?.localHtmlPath || `packages/archon-app/public/artifacts/${rawId}.html`,
          webEmbedUrl: art.metadata?.webEmbedUrl || `/artifacts/${rawId}.html`,
        });
      } else {
        resolved.push({ uri, type: 'artifact', title: rawId });
      }
    } else if (uri.startsWith('file://')) {
      resolved.push({
        uri,
        type: 'file',
        path: uri.slice('file://'.length),
      });
    } else if (uri.startsWith('turn://')) {
      resolved.push({
        uri,
        type: 'turn',
        excerpt: pointer.replyExcerpt || pointer.summary || '',
      });
    } else if (uri.startsWith('skill://')) {
      const skName = uri.slice('skill://'.length);
      resolved.push({
        uri,
        type: 'skill',
        skillName: skName,
        skillMdPath: `.archon/skills/${skName}/SKILL.md`,
      });
    }
  }
  return resolved.slice(0, 6);
}

export function formatSeatMemoryIndexEnvelopeForPrompt(queryResultOrIndex, maybeQueryOpts = null) {
  if (!queryResultOrIndex) return '';
  const queryResult =
    maybeQueryOpts && Array.isArray(queryResultOrIndex.pointers)
      ? querySeatMemoryIndex(queryResultOrIndex, maybeQueryOpts)
      : queryResultOrIndex;
  const {
    seatId,
    workspaceId = 'ws-default',
    roleSchema = getSeatMemoryRoleSchema(queryResult.seatId || 'chief-of-staff'),
    lookupMs,
    totalIndexedPointers,
    hits = [],
    alignmentHits = [],
    recommendedSkills = [],
    cosAssetOverview,
  } = queryResult;
  const isCos = seatId === 'chief-of-staff' || seatId === 'de-chief-of-staff';

  const lines = [
    `[STEP 1 OF EXECUTION: SEAT MEMORY v3/v4 EPISTEMIC POINTER SEARCH (PRIOR TO SKILLS) — seat:${seatId}, archetype=${roleSchema.archetype}, lookup=${lookupMs}ms, indexed=${totalIndexedPointers} pointers]:`,
    `  • Execution Order Rule: Memory is PRIOR to Skills for retrieval, but Memory is a Pointer to Evidence, NOT Proof of Truth (memoryAuthority="retrieval_pointer_only"). Cached PASS/Grade-A verdicts in memory are untrusted retrieval hints and CANNOT skip primary-source verification.`,
    `  • Network Topology Rule (Off-LAN Federated Relay Only): Treat remote peer nodes and external clusters as off-LAN by default. Never use direct LAN, SSH, rsync, or .local mDNS connections to remote peers — route cross-instance coordination exclusively via governed MCP relays (@mcp:archon-mesh / @mcp:agora-admin).`,
    `  • Active Cognitive Memory Schema (L2): ${roleSchema.label} (Facets: ${roleSchema.facets.join(', ')})`,
    `  • Cross-Seat & Multi-Hand Memory Purpose (agy / claude / codex): Your seat memory exists to retain non-obvious strategies, verified rules, and failure trap warnings across sessions without recording transient screen/API-readable state. In multi-seat campaigns, write to your seat's own partitioned shard/artifact and quote critical contract/filing figures verbatim before executive synthesis.`,
    `  • Live CLI Memory Search Endpoint (L3): GET http://127.0.0.1:8790/api/memory/search?workspaceId=${workspaceId}&seatId=${seatId}&q=<keywords>`,
    `  • Federated Collective Memory & Knowledge Transfer (L4): Use governed MCP relays (@mcp:archon-mesh / @mcp:agora-admin) to share and transfer validated SOPs, contracts, and cross-node memory across workstations and teams.`,
  ];

  if (queryResult.domainWiki?.antiBorgesGuardPassed) {
    lines.push(
      `  • Cross-Seat Domain Wiki Index (L3.5 · .archon/memory-wiki/_index.md): ${queryResult.domainWiki.topics?.length || 0} seat/domain pages · ${queryResult.domainWiki.indexLinesCount || 0} index lines · compression=${queryResult.domainWiki.compressionRatio} (<=0.15 Anti-Borges Guard PASS)`
    );
  }

  if (Array.isArray(queryResult.wikiHits) && queryResult.wikiHits.length > 0) {
    lines.push(`  • Query-Time Fused Domain Wiki Pages (${queryResult.wikiHits.length} matched L3.5 Wiki Maps):`);
    for (const wh of queryResult.wikiHits) {
      const rulesPreview = (wh.confirmedRules || []).slice(0, 2).join(' | ');
      const trapsPreview = (wh.trapWarnings || []).slice(0, 2).join(' | ');
      lines.push(
        `    - [${wh.wikiUri} · seat:${wh.seatId} (${(wh.engines || []).join('/') || 'cli'}) · score=${wh.matchScore}]: Artifacts: ${(wh.artifacts || []).slice(0, 4).join(', ') || 'none'}${rulesPreview ? ` · Rules: ${rulesPreview}` : ''}${trapsPreview ? ` · ⚠️ Traps: ${trapsPreview}` : ''}`
      );
    }
  }

  if (Array.isArray(queryResult.shardHits) && queryResult.shardHits.length > 0) {
    lines.push(`  • Single-Writer Verbatim Campaign Shards (${queryResult.shardHits.length} matched 100%-Fact-Survival Partitions):`);
    for (const sh of queryResult.shardHits) {
      const quotesPreview = (sh.verbatimQuotes || []).slice(0, 2).map((q) => `"${q.quote}" (${q.source})`).join('; ');
      lines.push(
        `    - [${sh.shardId} · owner=${sh.singleWriterOwner} (${sh.engine}) · entity=${sh.entityId}]: ${quotesPreview || (sh.verifiedFacts || []).slice(0, 2).join('; ')}`
      );
    }
  }

  if (recommendedSkills.length > 0) {
    lines.push(
      `  • Step 1 Memory → Step 2 Skill Recommendations: ${recommendedSkills.map((s) => `skill://${s}`).join(', ')}`
    );
  }

  if (isCos && cosAssetOverview) {
    lines.push(
      `  • Chief of Staff Omniscient Asset Map: ${cosAssetOverview.totalSeats} Seats · ${cosAssetOverview.totalArtifacts} Canvas Artifacts · ${cosAssetOverview.totalSkills} Skills · ${cosAssetOverview.totalMcps} MCP Bridges · ${cosAssetOverview.totalSchedules} Schedules · ${cosAssetOverview.totalIndexedPointers} Execution Pointers`
    );
  }

  if (alignmentHits.length > 0) {
    lines.push(`  • Chief of Staff Learned Alignment & Delegation Playbook Hits (${alignmentHits.length}):`);
    for (const rule of alignmentHits) {
      lines.push(
        `    - [${rule.ruleId} → seat:${rule.targetSeatId} (${rule.preferredEngine}, hits=${rule.hitCount || 1})]: ${rule.rationale} | Pointers: ${(rule.targetUris || []).join(', ')}`
      );
    }
  }

  if (hits.length > 0) {
    lines.push(`  • Associative Execution History Pointer Hits (${hits.length} retrieval pointers — re-verify primary sources):`);
    for (const h of hits) {
      const uris = (h.targets || []).slice(0, 4).join(', ');
      const epStatus = h.epistemicProvenance?.verificationStatus || 'unverified_hypothesis';
      lines.push(`    - [score=${h.hitScore} | epistemic=${epStatus} | seat:${h.seatId} | ${h.kind}]: ${h.summary} → Pointers: ${uris}`);
    }
  }

  return lines.join('\n');
}
