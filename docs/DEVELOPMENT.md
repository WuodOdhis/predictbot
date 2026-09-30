# Developer Guide

This guide covers running, configuring, and verifying Forecast Arena. For a description of the application, see the [README](../README.md).

## Run locally

Requires Node.js 20+, npm, and Foundry for contracts. Backend tests also use Foundry's `anvil` to verify signed transactions on an isolated local EVM.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API listens on http://127.0.0.1:3001. Both servers are local-only by default.

Without credentials, choose **Local practice**. Two clearly labelled statistical baselines forecast from real recent BOT testnet blocks. Commitments are recorded locally, while outcomes are collected from the real testnet. These are not AI or on-chain rounds.

An initial one-minute practice round takes about two minutes: 20 seconds for commits, 20 seconds for reveals, 60 seconds for observation, then block confirmations and evidence collection. Keep the backend running through the reveal deadline. SQLite preserves rounds and secrets across restarts, but a restart cannot recover a missed deadline.

## Enable on-chain AI rounds

Create `.env` using the variable names in [`.env.example`](../.env.example):

- `GROQ_API_KEY`: generate your own free-plan key at https://console.groq.com/keys.
- `DEPLOYER_PRIVATE_KEY`: a dedicated BOT **testnet** account, prefixed with `0x`. Fund its public address at https://faucet.botchain.ai/basic.
- `ARENA_CONTRACT_ADDRESS`: the address produced by deployment below.
- `ADMIN_TOKEN`: optional operator token for authenticated controls. Required before exposing controls through a remote proxy. The Settings screen accepts this access token, not provider or wallet secrets.

The default competitors are `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. Override with `GROQ_MODEL_A` / `GROQ_MODEL_B` if your account's catalog changes. Both receive identical context, a versioned prompt, and temperature 0. API responses identify the reported model; this is operator-attributed provenance, not cryptographic proof of model execution.

```bash
npm run contracts:build
npm run deploy:testnet
```

Deployment signs a transaction on chain **968 only** and prints its explorer link and contract address. Set `ARENA_CONTRACT_ADDRESS` locally, then restart the backend. The wallet must match the contract's immutable operator. Deployment is not performed automatically at startup.

The project's current testnet deployment is [`0xcd8da7961c607ad246dfb4a74ba2d07de38df346`](https://scan.bohr.life/address/0xcd8da7961c607ad246dfb4a74ba2d07de38df346). A different operator wallet needs its own contract deployment.

Open an **On-chain AI** round. The backend requests both forecasts before opening the round, then allows 120 seconds to commit and 90 seconds to reveal. Observation starts after reveal closes. A single worker serializes operator transactions. Run one backend instance against the database and operator wallet.

```bash
npm run build
npm start
```

This serves the built interface and API together at http://127.0.0.1:3001.

## Rules and verification

- A round's rules fix its chain, deadlines, observation interval, model metadata, shared input sample, prompt version, evaluator, and scoring.
- Outcomes count **all transactions, including reverted ones**, in canonical blocks whose timestamps satisfy `observationStart <= timestamp < observationEnd`.
- Collection waits until the end boundary has at least 12 successor blocks. This is a confirmation buffer, not an independently verified finality guarantee.
- The prototype's observation window is limited to 1, 5, or 10 minutes, and collection is capped at 6,000 blocks.
- Lowest absolute error wins each round. Ties share wins. The leaderboard separates statistical baselines from AI rounds, groups reported model versions separately, and displays scored rounds and missed reveals.
- Missing reveals are unscored, counted as misses, and remain visible. Cancelled rounds remain in history and do not count toward scores. This first leaderboard is descriptive, not a manipulation-resistant reputation mechanism.

Commitments use:

```text
keccak256(abi.encode(chainId, contractAddress, roundId, agentId, submitter, prediction, randomSalt))
agentId = keccak256(UTF8(agent identifier))
```

`GET /api/rounds` hides prediction values, reasoning, and salts until a successful reveal is recorded. Afterwards, it exposes `revealSalt` and the commitment domain for independent recomputation. Secrets are never placed in rules or frontend configuration.

`GET /api/rounds/:id/rules` returns the exact JSON bytes hashed into `rulesHash`. `GET /api/rounds/:id/evidence` returns the exact settled evidence JSON bytes hashed into `evidenceHash`. Hash UTF-8 response bytes using keccak256. Evidence lists block numbers, hashes, timestamps, transaction counts, boundary blocks, and the total. Verify against an independent RPC if needed.

**Trust model:** the operator submits outcomes and can cancel unsettled rounds. A hash anchors a record; it does not prove its contents are true. RPC counts, model attribution, execution, and outcome publication rely on the operator. There is no trustless oracle or dispute mechanism in this prototype. The contract does not hold funds.

## Checks

```bash
npm test
npm run contracts:test
npm run build
```

With `npm run dev` running, `npm run test:e2e` exercises a real testnet practice round, verifies commitments and evidence digests, checks desktop/mobile rendering, and tests cancellation. It uses system Chrome at `/usr/bin/google-chrome`; override with `CHROME_PATH`. Run it only with no active round, since it creates persistent practice records.

## Storage and hosting

Persist and back up `data/arena.sqlite` together with its WAL files when applicable. It contains unrevealed forecast secrets. Never publish `data/`, `.env`, or wallet keys. A public deployment also needs durable hosting, backups, provider-quota monitoring, HTTPS, and operator authentication.

### Hosted deployment

- Website: https://predictbot-flax.vercel.app (Vercel).
- Backend: https://predictbot-api.newtonesila.workers.dev (Cloudflare Workers).
- A single SQLite-backed Durable Object stores rounds and serializes the operator's transactions. Alarms wake it for reveal and settlement; it does not depend on browser polling.
- The local server and hosted worker use the same round engine in `shared/`. The hosted worker collects evidence and submits settlement in separate invocations to stay within the free request budget.
- The Vercel website proxies `/api/*` to Cloudflare. No signing key or model API key is uploaded to Vercel. `.vercelignore` excludes local credentials, databases, and generated artifacts.
- Cloudflare mutations require `ADMIN_TOKEN`. The token is stored in the local `.env`; enter it in the website's Settings to operate rounds. Never use a wallet private key or Groq API key in that field.
- Only listed `ALLOWED_ORIGINS` may make browser requests. Public reads do not require an operator token.
- Cloudflare's free tier has usage limits. It does not provide unlimited resources; exceeding free quotas stops the affected operations.

To deploy your own backend, authenticate with `npx wrangler login`, initialize your free `workers.dev` subdomain in the Cloudflare dashboard, and run:

```bash
npm run worker:deploy
ALLOWED_ORIGINS=https://your-website.vercel.app npx tsx scripts/configure-worker.ts
```

The configuration script uploads only the model key, testnet signing key, operator token, and allowed origins to Cloudflare's secret store. It generates an operator token locally if needed without printing it.

Update the API destination in `vercel.json` to your worker URL, then deploy the frontend through your Vercel account. Deploying the source with Vercel does not deploy or update the Cloudflare worker; run `npm run worker:deploy` for backend changes.

`scripts/migrate-rounds.ts` imports closed local rounds into the hosted backend. `scripts/check-hosted.ts` creates a real one-minute on-chain round and verifies its automated reveal, outcome evidence, and on-chain settlement. Both use the local operator token and default to this project's worker URL; override with `HOSTED_API_URL` for your own deployment.
