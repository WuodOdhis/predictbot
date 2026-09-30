import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import '../server/network.js';
import { digest, makeCommitment } from '../shared/domain.js';
import { createChain } from '../shared/chain.js';

const config = dotenv.parse(readFileSync('.env', 'utf8'));
const url = process.env.HOSTED_API_URL || 'https://predictbot-api.newtonesila.workers.dev';
assert.ok(config.ADMIN_TOKEN, 'Local operator token is missing.');
const unauthenticated = await fetch(`${url}/api/rounds`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'practice', duration: 60 }),
});
assert.equal(unauthenticated.status, 401);
const response = await fetch(`${url}/api/rounds`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ADMIN_TOKEN}` },
  body: JSON.stringify({ mode: 'onchain', duration: 60 }),
  signal: AbortSignal.timeout(120_000),
});
assert.equal(response.status, 201, `Round creation failed: HTTP ${response.status}.`);
const created = (await response.json()) as any;
assert.ok(created.forecasts.every((f: any) => f.value === undefined && f.revealSalt === undefined));
console.log(
  JSON.stringify({ created: created.id, chainRoundId: created.chainRoundId, phase: created.phase }),
);
const deadline = Date.now() + 390_000;
let lastPhase = created.phase;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const rounds = (await (await fetch(`${url}/api/rounds`)).json()) as any[];
  const round = rounds.find((r) => r.id === created.id);
  assert.ok(round);
  if (round.phase !== lastPhase) {
    console.log(JSON.stringify({ phase: round.phase, workerError: round.lastError || null }));
    lastPhase = round.phase;
  }
  if (round.phase !== 'SETTLED') continue;
  assert.ok(round.forecasts.every((f: any) => f.revealedAt && f.error !== undefined));
  for (const forecast of round.forecasts) {
    const domain = round.commitmentDomain;
    assert.equal(
      makeCommitment(
        domain.chainId,
        domain.contract,
        BigInt(domain.roundId),
        digest(forecast.id),
        domain.submitter,
        forecast.value,
        forecast.revealSalt,
      ),
      forecast.commitment,
    );
  }
  const evidenceText = await (await fetch(`${url}/api/rounds/${round.id}/evidence`)).text();
  assert.equal(digest(evidenceText), round.evidenceHash);
  const chain = createChain({ BOT_RPC_URL: config.BOT_RPC_URL });
  const record = await chain.rpc.readContract({
    address: round.contractAddress,
    abi: chain.abi,
    functionName: 'rounds',
    args: [BigInt(round.chainRoundId)],
  });
  assert.equal(record[5], true);
  assert.equal(record[7], BigInt(round.outcome));
  assert.equal(record[8], round.evidenceHash);
  console.log(
    JSON.stringify({
      verified: true,
      outcome: round.outcome,
      settlementTransaction: round.settleTx,
    }),
  );
  process.exit(0);
}
throw new Error('Hosted round did not settle before the verification timeout.');
