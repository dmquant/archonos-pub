import { expect, test } from 'bun:test'
import { evaluateSkill, type Policy, type SkillProposal } from './skill-eligibility'

const pol: Policy = { k: 3, minTrajectories: 2, preExistingVerifierHashes: new Set(['v1']), approvedVerifierHashes: new Set() }
const samples = (t: string, ...r: boolean[]) => r.map((passed) => ({ trajectory: t, passed }))
const good: SkillProposal = {
  hash: 's', verifierHash: 'v1', verifierAuthoredWithProposal: false, fitTrajectories: ['f1'],
  heldOut: [...samples('a', true, true, true), ...samples('b', true, true, true)], verifierError: null, defeaters: [],
}

test('clean proposal passes but is never activatable', () => {
  const r = evaluateSkill(good, pol)
  expect(r.verdict).toBe('pass'); expect(r.n).toBe(2); expect(r.activatable).toBe(false)
})
test('empty held-out set is insufficient, not pass', () => {
  expect(evaluateSkill({ ...good, heldOut: [] }, pol).verdict).toBe('insufficient')
})
test('one disagreeing sample fails k-agreement', () => {
  const r = evaluateSkill({ ...good, heldOut: [...samples('a', true, false, true), ...samples('b', true, true, true)] }, pol)
  expect(r.verdict).toBe('fail')
})
test('fewer than k samples is insufficient', () => {
  expect(evaluateSkill({ ...good, heldOut: [...samples('a', true, true), ...samples('b', true, true, true)] }, pol).verdict).toBe('insufficient')
})
test('verifier error is insufficient', () => {
  expect(evaluateSkill({ ...good, verifierError: 'timeout' }, pol).verdict).toBe('insufficient')
})
test('co-authored verifier fails; unknown verifier is insufficient', () => {
  expect(evaluateSkill({ ...good, verifierAuthoredWithProposal: true, verifierHash: 'v2' }, pol).verdict).toBe('fail')
  expect(evaluateSkill({ ...good, verifierHash: 'v2' }, pol).verdict).toBe('insufficient')
})
test('held-out overlapping fit set fails', () => {
  expect(evaluateSkill({ ...good, fitTrajectories: ['a'] }, pol).verdict).toBe('fail')
})
test('open defeater blocks; answered one does not; grant widening routes to approval rail', () => {
  const d = { kind: 'grant-widening' as const, ref: 'mcp:x', answered: false }
  const open = evaluateSkill({ ...good, defeaters: [d] }, pol)
  expect(open.verdict).toBe('fail'); expect(open.needsApprovalRail).toBe(true)
  expect(evaluateSkill({ ...good, defeaters: [{ ...d, answered: true }] }, pol).verdict).toBe('pass')
})
test('fail outranks insufficiency', () => {
  expect(evaluateSkill({ ...good, heldOut: [], fitTrajectories: [], defeaters: [{ kind: 'regression', ref: 'r', answered: false }] }, pol).verdict).toBe('fail')
})
