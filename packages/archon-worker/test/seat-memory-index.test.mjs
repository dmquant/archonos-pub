import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEAT_MEMORY_ROLE_SCHEMAS,
  getSeatMemoryRoleSchema,
  loadOrInitMemoryIndex,
  recordExecutionMemoryPointer,
  invalidateMemoryPointersByRetraction,
  evaluateTurnSalienceForMemory,
  extractClosedLoopLearningRule,
  dreamConsolidateCrossSeatMemory,
  buildCrossSeatDomainWiki,
  upsertSeatVerbatimShard,
  synthesizeCampaignShards,
  exportDreamedAgoraPlaybook,
  querySeatMemoryIndex,
  formatSeatMemoryIndexEnvelopeForPrompt,
} from '../src/seat-memory-index.mjs';
import { startLocalEdgeServer } from '../src/dev-server.mjs';

test('Seat Memory v0.3: asymmetric memory role schemas differentiate Chief of Staff Meta-Memory from operator-defined specialist seats', () => {
  const cosSchema = getSeatMemoryRoleSchema('chief-of-staff');
  const engSchema = getSeatMemoryRoleSchema('specialist-eng');
  const rschSchema = getSeatMemoryRoleSchema('specialist-research');
  const quantSchema = getSeatMemoryRoleSchema('specialist-quant');
  const designSchema = getSeatMemoryRoleSchema('specialist-design');
  const customSchema = getSeatMemoryRoleSchema('custom-operator-seat');

  assert.equal(cosSchema.archetype, 'omniscient-meta-memory');
  assert.ok(cosSchema.facets.includes('liveAssetMap'));
  assert.ok(cosSchema.facets.includes('seatAlignmentLedger'));

  assert.equal(engSchema.archetype, 'procedural-codebase-index');
  assert.equal(rschSchema.archetype, 'epistemic-audit-index');
  assert.equal(quantSchema.archetype, 'timeseries-ledger-index');
  assert.equal(designSchema.archetype, 'visual-style-index');
  assert.equal(customSchema.archetype, 'specialist-domain-index');
  assert.ok(Object.keys(SEAT_MEMORY_ROLE_SCHEMAS).length >= 5);
});

test('Seat Memory v0.3: Memory-as-Index records ExecutionIndexPointers and fast-directs queries to turn://, artifact://, and file:// URIs', () => {
  const idx = loadOrInitMemoryIndex(null);
  const ptr = recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    sessionId: 'session-main',
    messageId: 'msg-a-test-canvas',
    seatId: 'specialist-design',
    routedByCos: true,
    routingReason: 'Adapted interactive Canvas dashboard for responsive split-view dock',
    engine: 'claude',
    kind: 'artifact-evolution',
    userPrompt: 'Update art-telemetry-matrix for responsive split-view sidebar icons',
    replyText: 'Generated packages/archon-app/public/artifacts/art-telemetry-matrix.html with responsive dock.',
    artifactUpdated: {
      artifactId: 'art-telemetry-matrix',
      revision: 25,
      localHtmlPath: 'packages/archon-app/public/artifacts/art-telemetry-matrix.html',
    },
    outcome: 'completed',
    latencyMs: 1200,
  });

  assert.ok(ptr);
  assert.ok(ptr.targets.includes('turn://ws-default/session-main/msg-a-test-canvas'));
  assert.ok(ptr.targets.includes('artifact://art-telemetry-matrix@r25'));
  assert.ok(ptr.targets.includes('file://packages/archon-app/public/artifacts/art-telemetry-matrix.html'));

  const res = querySeatMemoryIndex(idx, {
    query: 'telemetry matrix responsive sidebar dock',
    seatId: 'chief-of-staff',
    workspaceId: 'ws-default',
    limit: 5,
  });
  assert.ok(res.hitCount >= 1);
  assert.equal(res.hits[0].pointerId, ptr.pointerId);
  assert.ok(res.alignmentHits.length >= 1);

  const envelope = formatSeatMemoryIndexEnvelopeForPrompt(res);
  assert.ok(envelope.includes('SEAT MEMORY v3'));
  assert.ok(envelope.includes('artifact://art-telemetry-matrix@r25'));
});

test('Live HTTP /api/memory/index and /api/memory expose Seat Memory v0.3 pointers and CoS alignment ledger', async () => {
  const server = startLocalEdgeServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const idxRes = await fetch(`${base}/api/memory/index?seatId=chief-of-staff&q=workspace+orchestrator+telemetry`);
    assert.equal(idxRes.status, 200);
    const idxJson = await idxRes.json();
    assert.equal(idxJson.ok, true);
    assert.equal(idxJson.version, 'seat-memory-index.v3');
    assert.equal(idxJson.roleSchema.archetype, 'omniscient-meta-memory');
    assert.ok(idxJson.totalIndexedPointers > 0);
    assert.ok(idxJson.alignmentHits.some((r) => r.targetSeatId === 'chief-of-staff'));
    assert.ok(idxJson.cosAssetOverview.totalArtifacts >= 1);

    const memRes = await fetch(`${base}/api/memory?seatId=specialist-eng&q=telemetry`);
    assert.equal(memRes.status, 200);
    const memJson = await memRes.json();
    assert.equal(memJson.ok, true);
    assert.equal(memJson.memoryIndex.activeSeatSchema.archetype, 'procedural-codebase-index');
    assert.equal(memJson.memoryIndex.executionPriority, 'memory-prior-to-skills');
    assert.ok(
      memJson.globalMemory.some((m) => m.key === 'memory-prior-to-skills-execution-sop'),
      'Global memory must include the Memory-Prior-to-Skills Execution SOP'
    );
    assert.ok(
      memJson.globalMemory.every((m) => !/\b(?:GEV|301087\.SZ|Hormuz\s+Eastbound)\b/i.test(String(m.content || ''))),
      'Global memory must only keep universal SOPs and never entity-specific tickers/corridors'
    );

    const searchRes = await fetch(`${base}/api/memory/search?seatId=chief-of-staff&q=workspace+orchestrator+sop`).then((r) => r.json());
    assert.equal(searchRes.ok, true);
    assert.equal(searchRes.executionPriority, 'memory-prior-to-skills');
    assert.equal(searchRes.memoryAuthority, 'retrieval_pointer_only');
    assert.ok(searchRes.recommendedSkills.includes('workspace-orchestrator-sop'));
    assert.match(searchRes.promptEnvelope, /STEP 1 OF EXECUTION: SEAT MEMORY v3\/v4 EPISTEMIC POINTER SEARCH \(PRIOR TO SKILLS\)/);
  } finally {
    server.close();
  }
});

test('Seat Memory v4 Epistemic Pointer Spec: quarantines legacy 100k synthetic reports and supports retraction invalidation', () => {
  const idx = loadOrInitMemoryIndex(null);
  const legacyPtr = recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    sessionId: 'session-main',
    messageId: 'msg-legacy-synth-100k',
    seatId: 'specialist-research',
    userPrompt: 'Generate >= 100,000 characters monograph for SYNTH',
    replyText: 'Published art-stock-sop-nvda with 100K+ Monograph Compiler PASS.',
    outcome: 'completed',
  });
  assert.equal(legacyPtr.memoryAuthority, 'retrieval_pointer_only');
  assert.equal(legacyPtr.epistemicProvenance.verificationStatus, 'retracted_or_challenged');
  assert.equal(legacyPtr.epistemicProvenance.quarantinedFromCanonicalExemplars, true);

  const draftPtr = recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    sessionId: 'session-main',
    messageId: 'msg-tsm-draft',
    seatId: 'specialist-review',
    userPrompt: 'Review TSM accounting note',
    replyText: 'Draft note for TSM waiting for upstream evidence.',
    outcome: 'completed',
  });
  assert.equal(draftPtr.epistemicProvenance.verificationStatus, 'unverified_hypothesis');

  const wsState = {
    seatMemory: {
      'specialist-research': [{ id: 'm1', key: 'research-sop:TSM', content: 'TSM Grade A PASS' }],
    },
  };
  const retractRes = invalidateMemoryPointersByRetraction(idx, wsState, {
    symbol: 'TSM',
    reason: 'editor_downgrade_r2_formula_defect',
  });
  assert.ok(retractRes.invalidatedCount >= 1);
  assert.equal(draftPtr.epistemicProvenance.verificationStatus, 'retracted_or_challenged');
  assert.equal(wsState.seatMemory['specialist-research'][0].verificationStatus, 'retracted_or_challenged');
});

test('Seat Memory v0.4.5 Cross-Seat & Multi-Hand (agy / claude / codex): Salience Gate, Closed-Loop Rule+Trap Extraction, Offline Dreaming & Anti-Borges Wiki', () => {
  const idx = loadOrInitMemoryIndex(null);

  // 1. Salience Gate filters out transient status pings that can be read live from /api/health
  const pingSalience = evaluateTurnSalienceForMemory({
    userPrompt: 'ping',
    replyText: 'ok',
    kind: 'chat-turn-execution',
  });
  assert.equal(pingSalience.salient, false);
  const droppedPing = recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    sessionId: 'session-main',
    messageId: 'msg-ping-1',
    seatId: 'chief-of-staff',
    engine: 'agy',
    userPrompt: 'ping',
    replyText: 'ok',
  });
  assert.equal(droppedPing, null, 'Transient status pings should not pollute L3 pointer index');

  // 2. Closed-Loop Rule + Trap Warning extraction across agy, codex, and claude hands
  const codexPtr = recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    sessionId: 'session-main',
    messageId: 'msg-codex-rule-1',
    seatId: 'specialist-research',
    engine: 'codex',
    userPrompt: 'Verify primary filing hash for ACME and record SOP rule',
    replyText:
      'Rule: Always verify primaryFilingHash before promoting an epistemic verdict. Trap: Never skip primary filing arithmetic verification on cached Grade-A notes. Verified with 46/46 tests passing.',
    selectedSkills: ['workspace-orchestrator-sop'],
    outcome: 'completed',
  });
  assert.ok(codexPtr);
  assert.equal(codexPtr.learningRule.engine, 'codex');
  assert.equal(codexPtr.learningRule.ruleStatus, 'confirmed_rule');
  assert.match(codexPtr.learningRule.ruleStatement, /verify primaryFilingHash/i);
  assert.match(codexPtr.learningRule.trapWarning, /skip primary filing arithmetic/i);

  // 3. Record an initially wrong note on an operator-defined specialist seat (claude), followed by operator feedback + correction in transcript
  const buggyPtr = recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    sessionId: 'session-main',
    messageId: 'msg-harvest-bug',
    seatId: 'specialist-eng',
    engine: 'claude',
    userPrompt: 'Update art-telemetry-matrix in-place via Quote to Modify',
    replyText: 'Updated art-telemetry-matrix@r10 in outputs/ folder.',
    artifactUpdated: {
      artifactId: 'art-telemetry-matrix',
      revision: 10,
      localHtmlPath: 'packages/archon-app/public/artifacts/art-telemetry-matrix.html',
    },
    outcome: 'completed',
  });
  assert.ok(buggyPtr);

  const mockRuntime = {
    sharedStore: {
      artifacts: new Map([
        [
          'art-telemetry-matrix',
          {
            artifactId: 'art-telemetry-matrix',
            title: 'Sovereign Telemetry Matrix',
            currentRevision: 17,
            publishedBySeat: 'chief-of-staff',
          },
        ],
      ]),
      skills: new Map([
        ['workspace-orchestrator-sop', { name: 'workspace-orchestrator-sop', state: 'active' }],
      ]),
    },
  };

  const mockWorkspaceState = {
    chatSessions: [
      {
        id: 'session-main',
        messages: [
          {
            id: 'msg-harvest-bug',
            role: 'assistant',
            seatId: 'specialist-eng',
            engine: 'claude',
            content: 'Updated art-telemetry-matrix@r10 in outputs/ folder.',
          },
          {
            id: 'msg-u-feedback',
            role: 'user',
            content: 'The bug happened again: harvest re-published staged quoted-artifact copies over the in-place edit!',
          },
          {
            id: 'msg-a-fixed',
            role: 'assistant',
            seatId: 'specialist-eng',
            engine: 'claude',
            content:
              'Rule: Stage localHtmlPath before USER_OUTPUTS_DIR and compare stagedFileHashes so unchanged staged copies are never re-harvested.',
          },
        ],
      },
    ],
  };

  // 4. Run Cross-Seat & Multi-Hand Offline Dreaming consolidation
  const dreamRes = dreamConsolidateCrossSeatMemory(idx, {
    runtime: mockRuntime,
    workspaceState: mockWorkspaceState,
    writeWikiToDisk: false,
  });

  assert.equal(dreamRes.ok, true);
  assert.ok(dreamRes.transcriptsReplayed >= 2);
  assert.ok(dreamRes.contradictedNotesRewritten >= 1, 'Dreaming must rewrite notes contradicted by subsequent transcript turns');
  assert.ok(dreamRes.brokenLinksRepaired >= 1, 'Dreaming must repoint outdated @r10 artifact link to @r17');
  assert.equal(dreamRes.antiBorgesGuardPassed, true, 'Anti-Borges Wiki compression guard must pass (<= 0.15)');
  assert.ok(dreamRes.wikiIndexLines <= 150, 'Top-level _index.md must stay <= 150 lines');

  const updatedBuggyPtr = idx.pointers.find((p) => p.messageId === 'msg-harvest-bug');
  assert.equal(updatedBuggyPtr.outcome, 'corrected_by_dreaming');
  assert.match(updatedBuggyPtr.replyExcerpt, /Dreaming Consolidated Correction/);
  assert.ok(updatedBuggyPtr.targets.includes('artifact://art-telemetry-matrix@r17'));
});

test('Seat Memory v0.5: Single-Writer Verbatim Shards (100% fact survival), Query-Time Wiki+Shard+Pointer Fusion, and L4 Agora Playbook Promotion across all seats & hands', () => {
  const idx = loadOrInitMemoryIndex(null);

  // 1. Multi-seat & multi-hand Single-Writer Verbatim Shards (no shared-table overwrite contention)
  const shardResearch = upsertSeatVerbatimShard(idx, {
    workspaceId: 'ws-default',
    campaignId: 'cmp-q4-audit',
    seatId: 'specialist-research',
    engine: 'codex',
    entityId: 'ACME-CORP',
    verbatimQuotes: [
      { quote: 'Cloud segment revenue for Q3 reached $42.8B, up 94% YoY.', source: 'filing-10q-acme-2026q3#item2' },
    ],
    verifiedFacts: ['ACME Q3 gross margin held at 75.4%.'],
    primaryFilingHash: 'sha256:acme10q2026q3',
    targetUris: ['artifact://art-acme-audit@r3'],
    writeToDisk: false,
  });

  const shardQuant = upsertSeatVerbatimShard(idx, {
    workspaceId: 'ws-default',
    campaignId: 'cmp-q4-audit',
    seatId: 'specialist-quant',
    engine: 'codex',
    entityId: 'INDEX-VOL',
    verbatimQuotes: [
      { quote: 'Rolling 14-day realized volatility printed 18.4% on primary ledger.', source: 'ledger-vol-20261106' },
    ],
    verifiedFacts: ['Capacity utilization crossed 89.2% threshold.'],
    primaryFilingHash: 'sha256:vol20261106',
    targetUris: ['artifact://art-regime-monitor@r5'],
    writeToDisk: false,
  });

  const shardEng = upsertSeatVerbatimShard(idx, {
    workspaceId: 'ws-default',
    campaignId: 'cmp-q4-audit',
    seatId: 'specialist-eng',
    engine: 'claude',
    entityId: 'archon-memory-v5',
    verbatimQuotes: [
      { quote: 'Single-writer per-entity shard partitioning preserves 57/57 facts (100% survival vs 72% shared table).', source: 'harvey-lab-benchmark' },
    ],
    verifiedFacts: ['All operator seats and CLI hands (agy, claude, codex) write to isolated shardIds.'],
    writeToDisk: false,
  });

  assert.ok(shardResearch.shardId.includes('specialist-research-ACME-CORP'));
  assert.ok(shardQuant.shardId.includes('specialist-quant-INDEX-VOL'));
  assert.ok(shardEng.shardId.includes('specialist-eng-archon-memory-v5'));

  const synthesis = synthesizeCampaignShards(idx, {
    workspaceId: 'ws-default',
    campaignId: 'cmp-q4-audit',
  });
  assert.equal(synthesis.shardCount, 3);
  assert.equal(synthesis.totalVerbatimQuotes, 3);
  assert.equal(synthesis.totalVerifiedFacts, 3);
  assert.equal(synthesis.factSurvivalRate, 1.0);
  assert.match(synthesis.synthesisMd, /Cloud segment revenue for Q3 reached \$42\.8B/);
  assert.match(synthesis.synthesisMd, /Rolling 14-day realized volatility printed 18\.4%/);

  // 2. Record confirmed cross-seat rules (>=2 signals for anti-Borges wiki synthesis) and run Dreaming + L4 Agora Playbook Promotion
  recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    messageId: 'msg-v5-rule-1',
    seatId: 'chief-of-staff',
    engine: 'agy',
    userPrompt: 'Consolidate multi-seat campaign memory and enforce off-LAN federated relay rule',
    replyText:
      'Rule: Never use direct LAN SSH to remote peers; route all cross-node dispatches via governed MCP relays and single-writer verbatim shards.\nVerified by: `node --test packages/archon-worker/test/seat-memory-index.test.mjs` (all pass).\nTrap: Shared multi-agent summary tables drop 28% of primary clauses.',
    artifactUpdated: 'art-acme-audit@r3',
  });
  recordExecutionMemoryPointer(idx, {
    workspaceId: 'ws-default',
    messageId: 'msg-v5-rule-2',
    seatId: 'chief-of-staff',
    engine: 'claude',
    userPrompt: 'Audit ACME Cloud segment revenue verbatim shard synthesis',
    replyText:
      'Rule: Always synthesize campaign metrics from single-writer verbatim shards with primaryFilingHash.\nVerified by: `node --test packages/archon-worker/test/seat-memory-index.test.mjs` factSurvivalRate === 1.0.',
    artifactUpdated: 'art-regime-monitor@r5',
  });

  const dreamRes = dreamConsolidateCrossSeatMemory(idx, {
    writeWikiToDisk: false,
  });
  assert.equal(dreamRes.ok, true);
  assert.equal(dreamRes.agoraLibraryDocId, 'archonos-dreamed-seat-rules-v0.5.json');
  assert.ok(dreamRes.agoraRulesExported >= 2);

  const playbookDirect = exportDreamedAgoraPlaybook(idx, { writeToDisk: false });
  assert.equal(playbookDirect.libraryDocId, 'archonos-dreamed-seat-rules-v0.5.json');
  assert.equal(playbookDirect.version, 'seat-memory.v0.5');
  assert.ok(playbookDirect.rules.some((r) => r.seatId === 'chief-of-staff' && r.engine === 'agy'));

  // 3. Query-Time Wiki + Verbatim Shard + Pointer Fusion
  const qRes = querySeatMemoryIndex(idx, {
    seatId: 'chief-of-staff',
    workspaceId: 'ws-default',
    query: 'ACME Cloud segment revenue verbatim shard',
    limit: 6,
  });
  assert.ok(Array.isArray(qRes.wikiHits) && qRes.wikiHits.length >= 1, 'Query fusion must return L3.5 Domain Wiki hits');
  assert.ok(Array.isArray(qRes.shardHits) && qRes.shardHits.length >= 1, 'Query fusion must return Single-Writer Verbatim Shard hits');

  const promptEnvelope = formatSeatMemoryIndexEnvelopeForPrompt(qRes);
  assert.match(promptEnvelope, /Query-Time Fused Domain Wiki Pages/);
  assert.match(promptEnvelope, /Single-Writer Verbatim Campaign Shards/);
  assert.match(promptEnvelope, /Cloud segment revenue for Q3 reached \$42\.8B/);
});
