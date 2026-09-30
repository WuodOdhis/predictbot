import { test, expect } from '@playwright/test';
import 'dotenv/config';
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';

test.beforeEach(async ({ page }) => {
  if (process.env.ADMIN_TOKEN)
    await page.addInitScript(
      (token) => sessionStorage.setItem('arena-token', token),
      process.env.ADMIN_TOKEN,
    );
});

test('real testnet practice lifecycle: hidden forecasts, reveal proofs, evidence and leaderboard', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByText('Network connected')).toBeVisible({ timeout: 60_000 });
  const existing = await (await request.get('/api/rounds')).json();
  expect(existing.filter((r: any) => !['SETTLED', 'CANCELLED'].includes(r.phase))).toHaveLength(0);
  await page.getByRole('button', { name: 'New round', exact: true }).click();
  const status = await (await request.get('/api/status')).json();
  if (Object.values(status.configured).every(Boolean))
    await expect(page.getByRole('button', { name: /On-chain AI/ })).toBeEnabled();
  else await expect(page.getByRole('button', { name: /On-chain AI/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Open round', exact: true }).click();
  await expect(page.getByText('Sealed forecast')).toHaveCount(2, { timeout: 30_000 });
  const initial = await (await request.get('/api/rounds')).json();
  const round = initial[0];
  expect(round.mode).toBe('practice');
  for (const f of round.forecasts) {
    expect(f.value).toBeUndefined();
    expect(f.reasoning).toBeUndefined();
    expect(f.revealSalt).toBeUndefined();
    expect(f.commitment).toMatch(/^0x[0-9a-f]{64}$/);
  }
  const rules = await (await request.get(`/api/rounds/${round.id}/rules`)).text();
  expect(keccak256(stringToHex(rules))).toBe(round.rulesHash);
  await page.screenshot({ path: '/tmp/opencode/arena-desktop-sealed.png', fullPage: true });
  await expect(page.getByText('Revealed', { exact: true })).toHaveCount(2, { timeout: 45_000 });
  const revealed = (await (await request.get('/api/rounds')).json())[0];
  for (const f of revealed.forecasts) {
    const d = revealed.commitmentDomain;
    const proof = keccak256(
      encodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
        ],
        [
          BigInt(d.chainId),
          d.contract as Hex,
          BigInt(d.roundId),
          keccak256(stringToHex(f.id)),
          d.submitter as Hex,
          BigInt(f.value),
          f.revealSalt as Hex,
        ],
      ),
    );
    expect(proof).toBe(f.commitment);
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('heading', { name: 'Forecast Arena', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/opencode/arena-mobile-${width}.png`, fullPage: true });
  }
  const pixelCheck = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) painted++;
    return painted;
  });
  expect(pixelCheck).toBeGreaterThan(100);
  await expect
    .poll(async () => (await (await request.get('/api/rounds')).json())[0].phase, {
      timeout: 160_000,
      intervals: [3000],
    })
    .toBe('SETTLED');
  const settled = (await (await request.get('/api/rounds')).json())[0];
  const evidenceText = await (await request.get(`/api/rounds/${round.id}/evidence`)).text();
  const evidence = JSON.parse(evidenceText);
  expect(keccak256(stringToHex(evidenceText))).toBe(settled.evidenceHash);
  expect(evidence.blocks.reduce((n: number, b: any) => n + b.transactions, 0)).toBe(
    settled.outcome,
  );
  expect(
    evidence.blocks.every(
      (b: any) => b.timestamp >= round.observationStart && b.timestamp < round.observationEnd,
    ),
  ).toBe(true);
  expect(evidence.previousBlock.timestamp).toBeLessThan(round.observationStart);
  expect(evidence.endBoundary.timestamp).toBeGreaterThanOrEqual(round.observationEnd);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByText('Settled', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/opencode/arena-desktop-settled.png', fullPage: true });
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click();
  await page.getByRole('button', { name: 'Baselines', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Recent mean', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('round cancellation persists in history and request validation blocks unsupported input', async ({
  page,
  request,
}) => {
  const invalid = await request.post('/api/rounds', { data: { mode: 'practice', duration: 1 } });
  expect(invalid.status()).toBe(400);
  const crossSite = await request.post('/api/rounds', {
    headers: { Origin: 'https://unrelated.example' },
    data: { mode: 'practice', duration: 60 },
  });
  expect(crossSite.status()).toBe(403);
  await page.goto('/');
  await page.getByRole('button', { name: 'New round', exact: true }).click();
  await page.getByRole('button', { name: 'Open round', exact: true }).click();
  await expect(page.getByText('Sealed forecast')).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Cancel round', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel round', exact: true }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Round history', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Cancelled', exact: true }).first()).toBeVisible();
});
