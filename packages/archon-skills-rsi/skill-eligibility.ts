// ArchonOS skill verification & eligibility — pure function (ARC-138 §1, 9188fc7d-a1f5-4607-a082-9118c2134ecb).
// Three answers, never collapsed: pass | fail | insufficient. Every verdict carries n.
// PROTOTYPE: untested as an ArchonOS component; no I/O, no clock, no counters.

export type Verdict = 'pass' | 'fail' | 'insufficient'

export interface Sample { trajectory: string; passed: boolean }

export interface Defeater { kind: 'regression' | 'user-correction' | 'grant-widening'; ref: string; answered: boolean }

export interface SkillProposal {
  hash: string
  verifierHash: string
  verifierAuthoredWithProposal: boolean
  fitTrajectories: readonly string[]
  heldOut: readonly Sample[]
  verifierError: string | null
  defeaters: readonly Defeater[]
}

export interface Policy {
  k: number                       // samples required per held-out trajectory
  minTrajectories: number         // floor on n; below it the verdict is insufficient
  preExistingVerifierHashes: ReadonlySet<string>
  approvedVerifierHashes: ReadonlySet<string>
}

export interface Eligibility {
  verdict: Verdict
  n: number                       // held-out trajectories examined
  reasons: string[]
  needsApprovalRail: boolean      // grant-widening goes to trade's approval rail regardless of score
  activatable: false              // replay pass is necessary, never sufficient; activation is a separate ledger act
}

export function evaluateSkill(p: SkillProposal, pol: Policy): Eligibility {
  const reasons: string[] = []
  const insufficient: string[] = []
  const by = new Map<string, boolean[]>()
  for (const s of p.heldOut) by.set(s.trajectory, [...(by.get(s.trajectory) ?? []), s.passed])
  const n = by.size

  const fit = new Set(p.fitTrajectories)
  const leaked = [...by.keys()].filter((t) => fit.has(t))
  if (leaked.length) reasons.push(`held-out overlaps fit set: ${leaked.join(',')}`)

  const verifierOk = pol.preExistingVerifierHashes.has(p.verifierHash) || pol.approvedVerifierHashes.has(p.verifierHash)
  if (p.verifierAuthoredWithProposal && !pol.approvedVerifierHashes.has(p.verifierHash)) {
    reasons.push('verifier co-authored with proposal and not separately approved')
  } else if (!verifierOk) {
    insufficient.push(`verifier ${p.verifierHash} is neither pre-existing nor approved`)
  }

  if (p.verifierError) insufficient.push(`verifier error: ${p.verifierError}`)
  if (n < pol.minTrajectories) insufficient.push(`n=${n} below floor ${pol.minTrajectories}`)
  const short = [...by].filter(([, v]) => v.length < pol.k).map(([t]) => t)
  if (short.length) insufficient.push(`fewer than k=${pol.k} samples: ${short.join(',')}`)

  const failed = [...by].filter(([, v]) => v.length >= pol.k && !v.every(Boolean)).map(([t]) => t)
  if (failed.length) reasons.push(`k-agreement not met on: ${failed.join(',')}`)

  const open = p.defeaters.filter((d) => !d.answered)
  for (const d of open) reasons.push(`defeater open (${d.kind}): ${d.ref}`)

  // Precedence: a refusing finding outranks an insufficiency (same ladder as capability.ts).
  const verdict: Verdict = reasons.length ? 'fail' : insufficient.length ? 'insufficient' : 'pass'
  return {
    verdict,
    n,
    reasons: [...reasons, ...insufficient],
    needsApprovalRail: p.defeaters.some((d) => d.kind === 'grant-widening'),
    activatable: false,
  }
}
