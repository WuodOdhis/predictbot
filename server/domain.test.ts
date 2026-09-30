import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, makeCommitment, phase, publicRound, type Round } from './domain.js';
import { parseForecast } from './models.js';
import { lowerBoundTimestamp } from './chain.js';

const salt = `0x${'ab'.repeat(32)}` as const;
function fixture(): Round {
  return {
    id: 'test',
    mode: 'practice',
    createdAt: 1,
    commitDeadline: 10,
    revealDeadline: 20,
    observationStart: 20,
    observationEnd: 30,
    rules: '{}',
    rulesHash: digest('{}'),
    cancelled: false,
    activity: [],
    forecasts: [
      {
        id: 'a',
        name: 'Model',
        kind: 'model',
        value: 42,
        salt,
        reasoning: 'Secret explanation',
        committedAt: 2,
      },
    ],
  };
}
test('unrevealed forecasts never expose prediction, explanation or salt', () => {
  const round = fixture();
  for (const clock of [5, 15, 25, 40]) {
    const json = JSON.stringify(publicRound(round, clock));
    assert.ok(!json.includes('Secret explanation'));
    assert.ok(!json.includes(salt));
    assert.equal(publicRound(round, clock).forecasts[0].value, undefined);
  }
  round.forecasts[0].revealedAt = 15;
  assert.equal(publicRound(round, 25).forecasts[0].value, 42);
  assert.equal(publicRound(round, 25).forecasts[0].revealSalt, salt);
});
test('phase boundaries and zero-valued settlement', () => {
  const round = fixture();
  assert.equal(phase(round, 9), 'COMMIT');
  assert.equal(phase(round, 10), 'REVEAL');
  assert.equal(phase(round, 20), 'OBSERVING');
  assert.equal(phase(round, 30), 'AWAITING_RESULT');
  round.outcome = 0;
  assert.equal(phase(round, 30), 'SETTLED');
  round.cancelled = true;
  assert.equal(phase(round), 'CANCELLED');
});
test('commitments cannot be replayed into another agent or round', () => {
  const address = `0x${'11'.repeat(20)}` as const;
  const a = makeCommitment(968, address, 1n, digest('a'), address, 42, salt);
  assert.notEqual(a, makeCommitment(968, address, 2n, digest('a'), address, 42, salt));
  assert.notEqual(a, makeCommitment(968, address, 1n, digest('b'), address, 42, salt));
});
test('forecast parser rejects fractional, negative and oversized predictions', () => {
  assert.equal(
    parseForecast('```json\n{"prediction":0,"reasoning":"quiet chain"}\n```').prediction,
    0,
  );
  for (const prediction of [-1, 1.5, 1e12])
    assert.throws(() => parseForecast(JSON.stringify({ prediction, reasoning: 'test' })));
  assert.throws(() => parseForecast('not json'));
});
test('timestamp search includes the start, excludes the end and handles repeated timestamps', async () => {
  const times = [0, 10, 10, 20, 30];
  const read = async (n: bigint) => times[Number(n)];
  assert.equal(await lowerBoundTimestamp(10, 4n, read), 1n);
  assert.equal(await lowerBoundTimestamp(20, 4n, read), 3n);
  assert.equal(await lowerBoundTimestamp(11, 4n, read), 3n);
  assert.equal(await lowerBoundTimestamp(40, 4n, read), 5n);
});
