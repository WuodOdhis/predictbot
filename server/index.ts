import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cancelRound, createRound, exclusive, tick } from './arena.js';
import { phase, publicRound } from './domain.js';
import { rpc } from './chain.js';
import * as store from './store.js';
import {
  PublicAccessError,
  publicRoundStatus,
  reservePublicRound,
} from '../shared/public-access.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const configured = () => ({
  groq: Boolean(process.env.GROQ_API_KEY),
  wallet: Boolean(process.env.DEPLOYER_PRIVATE_KEY),
  contract: Boolean(process.env.ARENA_CONTRACT_ADDRESS),
});
function isOperator(req: express.Request) {
  const token = process.env.ADMIN_TOKEN;
  if (!token)
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
  const supplied = req.get('authorization')?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(supplied),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
const publicEnabled = () => Object.values(configured()).every(Boolean);
const samples: { block: string; timestamp: number; transactions: number }[] = [];
let network: { connected: boolean; blockNumber?: string; timestamp?: number; checkedAt?: number } =
  { connected: false };
let checkingNetwork = false;
async function checkNetwork() {
  if (checkingNetwork) return;
  checkingNetwork = true;
  try {
    const [chainId, block] = await Promise.all([rpc.getChainId(), rpc.getBlock()]);
    network = {
      connected: chainId === 968,
      blockNumber: block.number.toString(),
      timestamp: Number(block.timestamp),
      checkedAt: Date.now(),
    };
    if (samples.at(-1)?.block !== block.number.toString()) {
      samples.push({
        block: block.number.toString(),
        timestamp: Number(block.timestamp),
        transactions: block.transactions.length,
      });
      if (samples.length > 40) samples.shift();
    }
  } catch {
    network = { connected: false, checkedAt: Date.now() };
  } finally {
    checkingNetwork = false;
  }
}
app.get('/api/status', (req, res) =>
  res.json({
    network,
    samples,
    configured: configured(),
    authRequired: Boolean(process.env.ADMIN_TOKEN),
    permissions: { operator: isOperator(req) },
    publicRounds: { ...publicRoundStatus(store.getPublicUsage()), enabled: publicEnabled() },
    chainId: 968,
    explorer: 'https://scan.bohr.life',
    contract: process.env.ARENA_CONTRACT_ADDRESS || null,
    serverTime: Date.now(),
  }),
);
app.get('/api/rounds', (_req, res) => res.json(store.all().map((r) => publicRound(r))));
app.get('/api/rounds/:id/rules', (req, res) => {
  const round = store.get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  // Return exact bytes used for the rules commitment, not reformatted JSON.
  res.type('application/json').send(round.rules);
});
app.get('/api/rounds/:id/evidence', (req, res) => {
  const round = store.get(req.params.id);
  if (!round?.evidence || round.outcome === undefined)
    return res.status(404).json({ error: 'No settled evidence is available yet.' });
  res.type('application/json').send(JSON.stringify(round.evidence));
});

app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(host) &&
      (!process.env.ADMIN_TOKEN || !isOperator(req))
    )
      return res
        .status(403)
        .json({ error: 'Remote round controls require ADMIN_TOKEN on the server.' });
  }
  if (req.method === 'POST' && req.path === '/rounds') return next();
  const token = process.env.ADMIN_TOKEN;
  if (token) {
    const supplied = req.get('authorization')?.replace(/^Bearer /, '') || '';
    const a = Buffer.from(supplied),
      b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return res.status(401).json({ error: 'Enter the operator access token in Settings.' });
  } else if (
    req.socket.remoteAddress &&
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  ) {
    return res
      .status(403)
      .json({ error: 'Round controls are local-only until ADMIN_TOKEN is configured.' });
  }
  next();
});
const roundInput = z
  .object({
    mode: z.enum(['practice', 'onchain']),
    duration: z.union([z.literal(60), z.literal(300), z.literal(600)]),
  })
  .strict();
app.post('/api/rounds', async (req, res, next) => {
  try {
    const input = roundInput.parse(req.body);
    const round = await exclusive(async () => {
      if (!isOperator(req)) {
        const usage = reservePublicRound(
          input,
          store.getPublicUsage(),
          store.all().some((r) => !['SETTLED', 'CANCELLED'].includes(phase(r))),
          publicEnabled(),
        );
        store.savePublicUsage(usage);
      }
      return createRound(input.mode, input.duration);
    });
    res.status(201).json(publicRound(round));
  } catch (error) {
    next(error);
  }
});
app.post('/api/rounds/:id/cancel', async (req, res, next) => {
  try {
    await exclusive(() => cancelRound(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
app.post('/api/worker/retry', async (_req, res, next) => {
  try {
    await exclusive(tick);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
if (existsSync('dist/index.html')) {
  app.use(express.static('dist'));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
}
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof PublicAccessError) {
      if (error.retryAt)
        res.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))),
        );
      res.status(error.status).json({ error: error.message, retryAt: error.retryAt });
      return;
    }
    const message =
      error instanceof z.ZodError
        ? 'Choose a supported round mode and duration.'
        : error instanceof Error
          ? error.message.split('\n')[0].slice(0, 240)
          : 'Request failed.';
    res.status(400).json({ error: message });
  },
);
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  exclusive(tick).finally(() => {
    ticking = false;
  });
}, 3000).unref();
setInterval(checkNetwork, 15_000).unref();
void checkNetwork();
app.listen(Number(process.env.PORT || 3001), '127.0.0.1', () =>
  console.log(`Arena API: http://127.0.0.1:${process.env.PORT || 3001}`),
);
