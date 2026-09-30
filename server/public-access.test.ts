import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PublicAccessError,
  PUBLIC_ROUND_LIMITS,
  publicRoundStatus,
  readRoundJson,
  reservePublicRound,
  type PublicUsage,
} from '../shared/public-access.js';
import worker from '../cloudflare/worker.js';

const input = { mode: 'onchain', duration: 60 };
const now = Date.parse('2026-09-30T12:00:00Z');
const statusIs = (status: number) => (error: unknown) =>
  error instanceof PublicAccessError && error.status === status;

test('public access only admits the fixed one-minute AI experiment', () => {
  assert.throws(
    () => reservePublicRound({ mode: 'practice', duration: 60 }, undefined, false, true, now),
    statusIs(403),
  );
  assert.throws(
    () => reservePublicRound({ mode: 'onchain', duration: 600 }, undefined, false, true, now),
    statusIs(403),
  );
  assert.throws(() => reservePublicRound(input, undefined, false, false, now), statusIs(503));
  assert.throws(() => reservePublicRound(input, undefined, true, true, now), statusIs(409));
  assert.deepEqual(reservePublicRound(input, undefined, false, true, now), {
    day: '2026-09-30',
    attempts: 1,
    lastAttempt: now,
  });
});

test('public quota stops the thirteenth attempt and supplies a reset time', () => {
  let usage: PublicUsage | undefined;
  for (let i = 0; i < PUBLIC_ROUND_LIMITS.dailyLimit; i++) {
    usage = reservePublicRound(input, usage, false, true, now + i * 60_000);
  }
  const state = publicRoundStatus(usage, now + 12 * 60_000);
  assert.equal(state.remaining, 0);
  assert.equal(state.retryAt, Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(
    () => reservePublicRound(input, usage, false, true, now + 12 * 60_000),
    statusIs(429),
  );
});

test('cooldown survives UTC midnight while the daily budget resets', () => {
  const last = Date.parse('2026-09-30T23:59:50Z');
  const usage = { day: '2026-09-30', attempts: 12, lastAttempt: last };
  const next = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(publicRoundStatus(usage, next).remaining, 12);
  assert.throws(() => reservePublicRound(input, usage, false, true, next), statusIs(429));
  const reservation = reservePublicRound(input, usage, false, true, last + 60_000);
  assert.equal(reservation.attempts, 1);
  assert.equal(reservation.day, '2026-10-01');
});

test('a reserved attempt remains counted when the provider fails', () => {
  const usage = reservePublicRound(input, undefined, false, true, now);
  assert.equal(publicRoundStatus(usage, now + 60_000).remaining, 11);
  assert.throws(() => reservePublicRound(input, usage, false, true, now + 59_999), statusIs(429));
});

test('round payload parsing enforces a byte limit without trusting Content-Length', async () => {
  const request = (body: string) =>
    new Request('https://example.test/api/rounds', { method: 'POST', body });
  assert.deepEqual(await readRoundJson(request(JSON.stringify(input))), input);
  await assert.rejects(
    readRoundJson(request(JSON.stringify({ text: 'x'.repeat(9000) }))),
    statusIs(413),
  );
  await assert.rejects(
    readRoundJson(request(JSON.stringify({ text: '\u20ac'.repeat(3000) }))),
    statusIs(413),
  );
  await assert.rejects(readRoundJson(request('not json')), statusIs(400));
});

test('worker forwards anonymous creation but rejects every private mutation before dispatch', async () => {
  let forwarded = 0;
  const env = {
    ADMIN_TOKEN: 'test-only-admin-token',
    ALLOWED_ORIGINS: 'https://example.test',
    ARENA: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          forwarded++;
          return Response.json({ delegated: true });
        },
      }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const request = (path: string, token?: string, origin = 'https://example.test') =>
    new Request(`https://api.example.test${path}`, {
      method: 'POST',
      headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input),
    });
  assert.equal((await worker.fetch(request('/api/rounds'), env)).status, 200);
  assert.equal(forwarded, 1);
  for (const path of [
    '/api/worker/retry',
    '/api/operator/import',
    '/api/rounds/abc/cancel',
    '/api/rounds/',
  ]) {
    assert.equal((await worker.fetch(request(path), env)).status, 401);
  }
  assert.equal(
    (await worker.fetch(request('/api/rounds', undefined, 'https://unrelated.test'), env)).status,
    403,
  );
  assert.equal(forwarded, 1);
  assert.equal((await worker.fetch(request('/api/worker/retry', 'wrong-token'), env)).status, 401);
  assert.equal(
    (await worker.fetch(request('/api/worker/retry', env.ADMIN_TOKEN), env)).status,
    200,
  );
  assert.equal(forwarded, 2);
});
