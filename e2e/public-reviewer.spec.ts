import { test, expect } from '@playwright/test';

test('reviewer opens a fixed AI round without credentials; admin controls require verified permission', async ({
  page,
}) => {
  const now = Math.floor(Date.now() / 1000);
  let round: unknown;
  let submitted: unknown;
  let creationAuthorization: string | undefined;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/status') {
      return route.fulfill({
        json: {
          network: { connected: true, blockNumber: '1234' },
          configured: { groq: true, wallet: true, contract: true },
          authRequired: true,
          permissions: { operator: request.headers().authorization === 'Bearer test-admin' },
          publicRounds: {
            enabled: true,
            mode: 'onchain',
            duration: 60,
            dailyLimit: 12,
            remaining: round ? 11 : 12,
            retryAt: null,
          },
          contract: '0x1111111111111111111111111111111111111111',
          serverTime: Date.now(),
          samples: [{ block: '1234', timestamp: now, transactions: 2 }],
        },
      });
    }
    if (path === '/api/rounds' && request.method() === 'POST') {
      submitted = request.postDataJSON();
      creationAuthorization = request.headers().authorization;
      round = {
        id: 'test-round',
        mode: 'onchain',
        createdAt: now,
        commitDeadline: now + 120,
        revealDeadline: now + 210,
        observationStart: now + 210,
        observationEnd: now + 270,
        rules: '{}',
        rulesHash: `0x${'11'.repeat(32)}`,
        cancelled: false,
        phase: 'COMMIT',
        lastError: 'Test worker status',
        activity: [],
        forecasts: ['gpt-oss-120b', 'gpt-oss-20b'].map((name, i) => ({
          id: String(i),
          name,
          kind: 'model',
          committedAt: now,
          commitment: `0x${'22'.repeat(32)}`,
        })),
      };
      return route.fulfill({ status: 201, json: round });
    }
    if (path === '/api/rounds') return route.fulfill({ json: round ? [round] : [] });
    return route.fulfill({ status: 401, json: { error: 'Operator authentication required.' } });
  });
  await page.goto('/');
  await expect(page.getByText('12 / 12')).toBeVisible();
  await page.getByRole('button', { name: 'New round', exact: true }).click();
  await expect(page.getByText('On-chain AI', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox')).toBeDisabled();
  await expect(page.getByRole('combobox')).toHaveValue('60');
  await expect(page.getByRole('button', { name: /Local practice/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open round', exact: true }).click();
  await expect(page.getByText('Sealed forecast')).toHaveCount(2);
  expect(submitted).toEqual({ mode: 'onchain', duration: 60 });
  expect(creationAuthorization).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Cancel round', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry round worker', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Operator access token').fill('not-an-admin');
  await page
    .getByRole('button', { name: 'Save access token for this session', exact: true })
    .click();
  await expect(page.getByText('Token not recognized')).toBeVisible();
  await page.getByRole('button', { name: 'Arena', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel round', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Operator access token').fill('test-admin');
  await page
    .getByRole('button', { name: 'Save access token for this session', exact: true })
    .click();
  await expect(page.getByText('Operator verified')).toBeVisible();
  await page.getByRole('button', { name: 'Arena', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel round', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry round worker', exact: true })).toBeVisible();
});
