// ArchonOS Worker Epistemic Skill Verification Gate (Pillar 3f)
// Mirrors @epistates's verified packages/archon-skills-rsi/skill-eligibility.ts
// so Cloudflare Worker (ESM) and Bun both execute identical 3-valued logic:
// pass | fail | insufficient, k=3 agreement, pre-existing verifier hash,
// disjoint fit/held-out sets, and open defeater blocking.

export function evaluateSkillProposal(proposal, policy) {
  const reasons = [];
  const insufficient = [];
  const byTrajectory = new Map();

  for (const s of proposal.heldOut ?? []) {
    const prev = byTrajectory.get(s.trajectory) ?? [];
    byTrajectory.set(s.trajectory, [...prev, Boolean(s.passed)]);
  }
  const n = byTrajectory.size;

  const fit = new Set(proposal.fitTrajectories ?? []);
  const leaked = [...byTrajectory.keys()].filter((t) => fit.has(t));
  if (leaked.length > 0) {
    reasons.push(`held-out overlaps fit set: ${leaked.join(',')}`);
  }

  const preExisting = policy.preExistingVerifierHashes instanceof Set
    ? policy.preExistingVerifierHashes
    : new Set(policy.preExistingVerifierHashes ?? []);
  const approved = policy.approvedVerifierHashes instanceof Set
    ? policy.approvedVerifierHashes
    : new Set(policy.approvedVerifierHashes ?? []);

  const verifierOk = preExisting.has(proposal.verifierHash) || approved.has(proposal.verifierHash);
  if (proposal.verifierAuthoredWithProposal && !approved.has(proposal.verifierHash)) {
    reasons.push('verifier co-authored with proposal and not separately approved');
  } else if (!verifierOk) {
    insufficient.push(`verifier ${proposal.verifierHash} is neither pre-existing nor approved`);
  }

  if (proposal.verifierError) {
    insufficient.push(`verifier error: ${proposal.verifierError}`);
  }
  if (n < policy.minTrajectories) {
    insufficient.push(`n=${n} below floor ${policy.minTrajectories}`);
  }

  const short = [...byTrajectory.entries()]
    .filter(([, samples]) => samples.length < policy.k)
    .map(([t]) => t);
  if (short.length > 0) {
    insufficient.push(`fewer than k=${policy.k} samples: ${short.join(',')}`);
  }

  const failed = [...byTrajectory.entries()]
    .filter(([, samples]) => samples.length >= policy.k && !samples.every(Boolean))
    .map(([t]) => t);
  if (failed.length > 0) {
    reasons.push(`k-agreement not met on: ${failed.join(',')}`);
  }

  const openDefeaters = (proposal.defeaters ?? []).filter((d) => !d.answered);
  for (const d of openDefeaters) {
    reasons.push(`defeater open (${d.kind}): ${d.ref}`);
  }

  const verdict = reasons.length > 0 ? 'fail' : insufficient.length > 0 ? 'insufficient' : 'pass';
  return {
    verdict,
    n,
    reasons: [...reasons, ...insufficient],
    needsApprovalRail: (proposal.defeaters ?? []).some((d) => d.kind === 'grant-widening'),
    activatable: false,
  };
}
