import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFirstAvailableHand, withDefaultChiefHand } from '../src/local-hands-runner.mjs';

test('Chief of Staff selects the first installed and enabled CLI in discovery order', () => {
  const hands = {
    claude: { installed: false, enabled: true },
    codex: { installed: true, enabled: true },
    agy: { installed: true, enabled: true },
  };
  assert.equal(selectFirstAvailableHand(hands), 'codex');
  assert.equal(selectFirstAvailableHand({ agy: hands.agy, codex: hands.codex }), 'agy');
  assert.equal(selectFirstAvailableHand({ codex: { installed: true, enabled: false }, agy: hands.agy }), 'agy');
  assert.equal(selectFirstAvailableHand({ opencode: { installed: true, enabled: true } }), 'opencode');
});

test('Existing Chief of Staff bindings migrate to this host without losing role or persona', () => {
  const seat = { id: 'chief-of-staff', hand: 'claude', engines: ['claude'], persona: 'Keep this role', handCustomizedByOperator: true };
  const result = withDefaultChiefHand(seat, { codex: { installed: true, enabled: true } });
  assert.equal(result.hand, 'codex');
  assert.deepEqual(result.engines, ['codex']);
  assert.equal(result.persona, seat.persona);
  assert.equal(result.handSelection, 'auto');
  assert.equal(result.handAvailable, true);
  assert.equal(seat.hand, 'claude', 'migration does not mutate the saved source object');
});

test('A machine without an enabled CLI never advertises an available dispatch engine', () => {
  const hands = { claude: { installed: false, enabled: true }, codex: { installed: true, enabled: false } };
  assert.equal(selectFirstAvailableHand(hands), null);
  const seat = withDefaultChiefHand({ id: 'chief-of-staff', hand: 'claude' }, hands);
  assert.equal(seat.handAvailable, false);
  assert.deepEqual(seat.engines, []);
});
