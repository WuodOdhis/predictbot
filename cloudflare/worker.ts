import type {
  DurableObjectNamespace,
  DurableObjectState,
  Request as WorkerRequest,
} from '@cloudflare/workers-types';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createArena, type RoundStore } from '../shared/arena.js';
import { createChain, type ChainConfig } from '../shared/chain.js';
import { digest, phase, publicRound, type Round } from '../shared/domain.js';
import { askModel } from '../shared/models.js';
import {
  PublicAccessError,
  publicRoundStatus,
  readRoundJson,
  reservePublicRound,
  type PublicUsage,
} from '../shared/public-access.js';

interface Env extends ChainConfig {
  ARENA: DurableObjectNamespace;
  GROQ_API_KEY?: string;
  GROQ_MODEL_A?: string;
  GROQ_MODEL_B?: string;
  ADMIN_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
}

function authorized(request: Request, token?: string) {
  if (!token) return false;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(supplied),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const roundInput = z
  .object({
    mode: z.enum(['practice', 'onchain']),
    duration: z.union([z.literal(60), z.literal(300), z.literal(600)]),
  })
  .strict();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    if (origin && allowed.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    } else if (origin) {
      return Response.json(
        { error: 'This website is not an allowed origin.' },
        { status: 403, headers },
      );
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'POST'].includes(request.method))
      return Response.json({ error: 'Method not allowed.' }, { status: 405, headers });
    const publicCreation = new URL(request.url).pathname === '/api/rounds';
    if (request.method === 'POST' && !publicCreation && !authorized(request, env.ADMIN_TOKEN)) {
      return Response.json(
        { error: 'Enter the operator access token in Settings.' },
        { status: 401, headers },
      );
    }
    const object = env.ARENA.get(env.ARENA.idFromName('predictbot-arena-v1'));
    const response = await object.fetch(request as unknown as WorkerRequest);
    response.headers.forEach((value, key) => headers.set(key, value));
    return new Response(response.body as unknown as ReadableStream, {
      status: response.status,
      headers,
    });
  },
};

export class ArenaWorker {
  private store: RoundStore;
  private chain: ReturnType<typeof createChain>;
  private arena: ReturnType<typeof createArena>;
  private samples: { block: string; timestamp: number; transactions: number }[] = [];
  private network: {
    connected: boolean;
    blockNumber?: string;
    timestamp?: number;
    checkedAt?: number;
  } = { connected: false };
  private checking?: Promise<void>;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    const sql = ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS public_usage (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)',
    );
    this.store = {
      save: (round) => {
        sql.exec(
          'INSERT INTO rounds VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
          round.id,
          round.createdAt,
          JSON.stringify(round),
        );
      },
      all: () =>
        sql
          .exec<{ body: string }>('SELECT body FROM rounds ORDER BY created_at DESC, rowid DESC')
          .toArray()
          .map((r) => JSON.parse(r.body)),
      get: (id) => {
        const row = sql
          .exec<{ body: string }>('SELECT body FROM rounds WHERE id = ?', id)
          .toArray()[0];
        return row ? JSON.parse(row.body) : undefined;
      },
    };
    this.chain = createChain(env);
    this.arena = createArena(
      this.store,
      this.chain,
      { ...env, deferSettlement: true },
      (model, context, seconds) => askModel(model, context, seconds, env.GROQ_API_KEY),
    );
  }

  private publicUsage(): PublicUsage | undefined {
    const row = this.ctx.storage.sql
      .exec<{ body: string }>('SELECT body FROM public_usage WHERE id = 1')
      .toArray()[0];
    return row ? JSON.parse(row.body) : undefined;
  }

  private publicEnabled() {
    return Boolean(
      this.env.GROQ_API_KEY && this.env.DEPLOYER_PRIVATE_KEY && this.env.ARENA_CONTRACT_ADDRESS,
    );
  }

  private async refreshNetwork() {
    if (this.checking) return this.checking;
    if (this.network.checkedAt && Date.now() - this.network.checkedAt < 15_000) return;
    this.checking = (async () => {
      try {
        const [chainId, block] = await Promise.all([
          this.chain.rpc.getChainId(),
          this.chain.rpc.getBlock(),
        ]);
        this.network = {
          connected: chainId === 968,
          blockNumber: block.number.toString(),
          timestamp: Number(block.timestamp),
          checkedAt: Date.now(),
        };
        if (this.samples.at(-1)?.block !== block.number.toString()) {
          this.samples.push({
            block: block.number.toString(),
            timestamp: Number(block.timestamp),
            transactions: block.transactions.length,
          });
          if (this.samples.length > 40) this.samples.shift();
        }
      } catch {
        this.network = { connected: false, checkedAt: Date.now() };
      }
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async schedule() {
    const active = this.store.all().find((r) => !['SETTLED', 'CANCELLED'].includes(phase(r)));
    if (!active) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const state = phase(active);
    let wake = now + 5000;
    if (state === 'COMMIT' && active.forecasts.every((f) => f.committedAt))
      wake = active.commitDeadline * 1000;
    else if (state === 'REVEAL' && active.forecasts.every((f) => f.revealedAt || f.failure))
      wake = active.observationEnd * 1000 + 12_000;
    else if (state === 'OBSERVING') wake = active.observationEnd * 1000 + 12_000;
    await this.ctx.storage.setAlarm(Math.max(now + 1000, wake));
  }

  async alarm() {
    // Schedule recovery before doing network work so an interrupted invocation can resume.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    try {
      await this.arena.exclusive(() => this.arena.tick());
    } finally {
      await this.schedule();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/api/status') {
        await this.refreshNetwork();
        return Response.json({
          network: this.network,
          samples: this.samples,
          configured: {
            groq: Boolean(this.env.GROQ_API_KEY),
            wallet: Boolean(this.env.DEPLOYER_PRIVATE_KEY),
            contract: Boolean(this.env.ARENA_CONTRACT_ADDRESS),
          },
          authRequired: true,
          permissions: { operator: authorized(request, this.env.ADMIN_TOKEN) },
          publicRounds: { ...publicRoundStatus(this.publicUsage()), enabled: this.publicEnabled() },
          chainId: 968,
          explorer: 'https://scan.bohr.life',
          contract: this.env.ARENA_CONTRACT_ADDRESS || null,
          serverTime: Date.now(),
          hosting: 'cloudflare',
        });
      }
      if (request.method === 'GET' && path === '/api/rounds')
        return Response.json(this.store.all().map((r) => publicRound(r)));
      const match = /^\/api\/rounds\/([^/]+)\/(rules|evidence)$/.exec(path);
      if (request.method === 'GET' && match) {
        const round = this.store.get(match[1]);
        if (!round || (match[2] === 'evidence' && (round.outcome === undefined || !round.evidence)))
          return Response.json({ error: 'Record not available.' }, { status: 404 });
        return new Response(match[2] === 'rules' ? round.rules : JSON.stringify(round.evidence), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'POST') {
        if (path === '/api/rounds') {
          const input = roundInput.parse(await readRoundJson(request));
          const round = await this.arena.exclusive(async () => {
            if (!authorized(request, this.env.ADMIN_TOKEN)) {
              const usage = reservePublicRound(
                input,
                this.publicUsage(),
                this.store.all().some((r) => !['SETTLED', 'CANCELLED'].includes(phase(r))),
                this.publicEnabled(),
              );
              // Reserve before model calls; failed attempts still consume the bounded public budget.
              this.ctx.storage.sql.exec(
                'INSERT INTO public_usage VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
                JSON.stringify(usage),
              );
            }
            await this.ctx.storage.setAlarm(Date.now() + 30_000);
            try {
              return await this.arena.createRound(input.mode, input.duration);
            } finally {
              await this.schedule();
            }
          });
          return Response.json(publicRound(round), { status: 201 });
        }
        if (!authorized(request, this.env.ADMIN_TOKEN))
          return Response.json({ error: 'Operator authentication required.' }, { status: 401 });
        const cancel = /^\/api\/rounds\/([^/]+)\/cancel$/.exec(path);
        if (cancel) {
          await this.arena.exclusive(async () => {
            await this.arena.cancelRound(cancel[1]);
            await this.schedule();
          });
          return Response.json({ ok: true });
        }
        if (path === '/api/worker/retry') {
          await this.arena.exclusive(async () => {
            await this.arena.tick();
            await this.schedule();
          });
          return Response.json({ ok: true });
        }
        if (path === '/api/operator/import') {
          const records = z
            .array(
              z
                .object({
                  id: z.string(),
                  mode: z.enum(['practice', 'onchain']),
                  createdAt: z.number().int(),
                  cancelled: z.boolean(),
                  rules: z.string(),
                  rulesHash: z.string(),
                  forecasts: z.array(z.unknown()),
                  activity: z.array(z.unknown()),
                })
                .passthrough(),
            )
            .max(100)
            .parse(await request.json()) as unknown as Round[];
          await this.arena.exclusive(async () => {
            for (const round of records) {
              if (
                !['SETTLED', 'CANCELLED'].includes(phase(round)) ||
                digest(round.rules) !== round.rulesHash
              )
                throw new Error('Only closed rounds with matching rules can be imported.');
              if (round.evidence && digest(JSON.stringify(round.evidence)) !== round.evidenceHash)
                throw new Error('Evidence hash mismatch.');
            }
            for (const round of records) if (!this.store.get(round.id)) this.store.save(round);
          });
          return Response.json({ imported: records.length });
        }
      }
      return Response.json({ error: 'Not found.' }, { status: 404 });
    } catch (error) {
      if (error instanceof PublicAccessError) {
        const headers = new Headers();
        if (error.retryAt)
          headers.set(
            'Retry-After',
            String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))),
          );
        return Response.json(
          { error: error.message, retryAt: error.retryAt },
          { status: error.status, headers },
        );
      }
      const message =
        error instanceof z.ZodError
          ? 'Invalid request.'
          : error instanceof Error
            ? error.message.split('\n')[0].slice(0, 240)
            : 'Request failed.';
      return Response.json({ error: message }, { status: 400 });
    }
  }
}
