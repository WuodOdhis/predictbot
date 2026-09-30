import { randomBytes, randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import type { createChain } from './chain.js';
import { digest, makeCommitment, phase, type Forecast, type Round } from './domain.js';
import type { askModel as modelRequest } from './models.js';

export interface RoundStore {
  save(round: Round): void;
  all(): Round[];
  get(id: string): Round | undefined;
}
export interface ArenaConfig {
  GROQ_API_KEY?: string;
  GROQ_MODEL_A?: string;
  GROQ_MODEL_B?: string;
  deferSettlement?: boolean;
}

export function createArena(
  store: RoundStore,
  chain: ReturnType<typeof createChain>,
  config: ArenaConfig,
  askModel: (model: string, context: unknown, seconds: number) => ReturnType<typeof modelRequest>,
) {
  const { abi, assertOperator, collectEvidence, contractAddress, recentStats, rpc, send, signer } =
    chain;

  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  }
  const now = () => Math.floor(Date.now() / 1000);
  const salt = () => `0x${randomBytes(32).toString('hex')}` as Hex;
  const zeroAddress = '0x0000000000000000000000000000000000000000' as Hex;
  function log(round: Round, message: string) {
    round.activity.push({ at: now(), message });
    store.save(round);
  }

  async function createRound(mode: 'practice' | 'onchain', duration: number) {
    if (store.all().some((r) => !['SETTLED', 'CANCELLED'].includes(phase(r))))
      throw new Error('Finish or cancel the active round before opening another.');
    const address = mode === 'onchain' ? contractAddress() : zeroAddress;
    if (mode === 'onchain') {
      if (!config.GROQ_API_KEY)
        throw new Error('Configure GROQ_API_KEY before opening an AI round.');
      await assertOperator(address);
    }
    const context = await recentStats();
    const forecasts: Forecast[] = [];
    if (mode === 'practice') {
      forecasts.push(
        {
          id: 'mean-baseline',
          name: 'Recent mean',
          kind: 'baseline',
          value: Math.round(context.meanRate * duration),
          salt: salt(),
          reasoning:
            'Recent transaction count divided by the elapsed sample time, projected over the observation window.',
        },
        {
          id: 'median-baseline',
          name: 'Block median',
          kind: 'baseline',
          value: Math.round(context.medianRate * duration),
          salt: salt(),
          reasoning:
            'Median transactions per sampled block multiplied by the observed block rate and observation duration.',
        },
      );
    } else {
      for (const [index, model] of [
        config.GROQ_MODEL_A || 'openai/gpt-oss-120b',
        config.GROQ_MODEL_B || 'openai/gpt-oss-20b',
      ].entries()) {
        const result = await askModel(model, context, duration);
        forecasts.push({
          id: `groq-${index}-${model}`,
          name: model.split('/').at(-1)!,
          model: result.reportedModel,
          kind: 'model',
          value: result.prediction,
          reasoning: result.reasoning,
          salt: salt(),
        });
      }
    }
    const createdAt = now();
    const commitDeadline = createdAt + (mode === 'onchain' ? 120 : 20);
    const revealDeadline = commitDeadline + (mode === 'onchain' ? 90 : 20);
    const observationStart = revealDeadline;
    const observationEnd = observationStart + duration;
    const rules = JSON.stringify({
      schema: 'forecast-arena/rules-v1',
      chainId: 968,
      question: 'How many BOT testnet transactions occur during the observation window?',
      commitDeadline,
      revealDeadline,
      observationStart,
      observationEnd,
      counting:
        'All transactions, including reverted transactions, in blocks with observationStart <= timestamp < observationEnd.',
      scoring:
        'Lowest absolute error wins; ties share rank; missing reveals are unscored and counted as misses.',
      evaluator:
        'Operator-reported result, supported by public block evidence; not a trustless oracle.',
      context,
      promptVersion: 'transaction-count-v1',
      models: forecasts.map((f) => ({ id: f.id, name: f.name, model: f.model, kind: f.kind })),
    });
    const round: Round = {
      id: randomUUID(),
      mode,
      createdAt,
      commitDeadline,
      revealDeadline,
      observationStart,
      observationEnd,
      rules,
      rulesHash: digest(rules),
      forecasts,
      cancelled: false,
      activity: [],
    };
    if (mode === 'onchain') {
      round.contractAddress = address;
      round.chainRoundId = (
        await rpc.readContract({ address, abi, functionName: 'nextRoundId' })
      ).toString();
      store.save(round);
      try {
        await send(
          address,
          'createRound',
          [round.rulesHash, commitDeadline, revealDeadline, observationStart, observationEnd],
          (hash) => {
            round.createTx = hash;
            store.save(round);
          },
        );
      } catch {
        round.lastError =
          'Round creation needs confirmation. The worker will check the recorded transaction.';
        store.save(round);
        return round;
      }
    }
    log(
      round,
      mode === 'practice'
        ? 'Practice round opened. Statistical baselines use real testnet data; commitments are local.'
        : 'On-chain AI round created. Both models received identical block data.',
    );
    try {
      await advance(round);
    } catch (error) {
      round.lastError =
        error instanceof Error
          ? error.message.split('\n')[0].slice(0, 240)
          : 'Round worker failed.';
      store.save(round);
    }
    return round;
  }

  async function advance(round: Round) {
    if (['SETTLED', 'CANCELLED'].includes(phase(round))) return;
    const onchain = round.mode === 'onchain';
    const address = round.contractAddress || zeroAddress;
    const id = onchain ? BigInt(round.chainRoundId!) : BigInt(`0x${round.id.replaceAll('-', '')}`);
    const submitter = onchain ? signer().account.address : zeroAddress;
    round.commitmentDomain = { chainId: 968, contract: address, roundId: id.toString(), submitter };
    store.save(round);
    if (onchain) {
      await assertOperator(address);
      const chainRound = await rpc.readContract({
        address,
        abi,
        functionName: 'rounds',
        args: [id],
      });
      if (chainRound[0] !== round.rulesHash) {
        if (!round.createTx)
          throw new Error(
            'No round creation transaction recorded. Cancel this local record and create a new round.',
          );
        const receipt = await rpc.getTransactionReceipt({ hash: round.createTx });
        if (receipt.status === 'reverted') {
          round.cancelled = true;
          log(round, 'Round creation reverted. No forecasts submitted.');
          return;
        }
        throw new Error('Waiting for matching on-chain round creation.');
      }
      if (chainRound[6]) {
        round.cancelled = true;
        log(round, 'Cancellation confirmed on-chain.');
        return;
      }
      if (chainRound[5]) {
        if (round.evidenceHash !== chainRound[8])
          throw new Error(
            'On-chain settlement does not match local evidence. Inspect operator activity.',
          );
        round.outcome = Number(chainRound[7]);
        log(round, 'Settlement confirmed on-chain.');
        return;
      }
    }
    const forecastErrors: string[] = [];
    for (const f of round.forecasts) {
      try {
        const agent = digest(f.id);
        if (!f.commitment) {
          f.commitment = makeCommitment(968, address, id, agent, submitter, f.value, f.salt);
          store.save(round);
        }
        if (onchain) {
          const p = await rpc.readContract({
            address,
            abi,
            functionName: 'predictions',
            args: [id, agent],
          });
          if (p[0] !== zeroAddress) {
            if (p[1] !== f.commitment)
              throw new Error('On-chain prediction differs from stored commitment.');
            f.committedAt ||= now();
            if (p[3]) f.revealedAt ||= now();
            store.save(round);
          }
        }
        if (!f.committedAt && now() < round.commitDeadline) {
          if (onchain && f.commitTx) {
            const receipt = await rpc.getTransactionReceipt({ hash: f.commitTx });
            if (receipt.status === 'success')
              throw new Error('Waiting for the recorded commitment to appear in contract state.');
            f.commitTx = undefined;
            store.save(round);
          }
          if (onchain)
            await send(address, 'commit', [id, agent, f.commitment], (hash) => {
              f.commitTx = hash;
              store.save(round);
            });
          f.committedAt = now();
          log(round, `${f.name} sealed its forecast.`);
        }
        if (
          !f.revealedAt &&
          f.committedAt &&
          now() >= round.commitDeadline &&
          now() < round.revealDeadline
        ) {
          if (onchain && f.revealTx) {
            const receipt = await rpc.getTransactionReceipt({ hash: f.revealTx });
            if (receipt.status === 'success')
              throw new Error('Waiting for the recorded reveal to appear in contract state.');
            f.revealTx = undefined;
            store.save(round);
          }
          if (onchain)
            await send(address, 'reveal', [id, agent, BigInt(f.value), f.salt], (hash) => {
              f.revealTx = hash;
              store.save(round);
            });
          f.revealedAt = now();
          log(round, `${f.name} revealed its forecast.`);
        }
        if (!f.revealedAt && now() >= round.revealDeadline && !f.failure) {
          f.failure = f.committedAt ? 'Reveal deadline missed' : 'Commit deadline missed';
          log(round, `${f.name}: ${f.failure.toLowerCase()}.`);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message.split('\n')[0].slice(0, 160)
            : 'Forecast submission failed.';
        forecastErrors.push(`${f.name}: ${message}`);
        store.save(round);
      }
    }
    if (now() >= round.observationEnd && round.outcome === undefined) {
      if (!round.evidence) {
        round.evidence = await collectEvidence(round.observationStart, round.observationEnd);
        round.evidenceHash = digest(JSON.stringify(round.evidence));
        store.save(round);
        if (config.deferSettlement) return;
      }
      if (onchain)
        await send(
          address,
          'settle',
          [id, BigInt(round.evidence.outcome), round.evidenceHash!],
          (hash) => {
            round.settleTx = hash;
            store.save(round);
          },
        );
      round.outcome = round.evidence.outcome;
      log(
        round,
        `Result recorded: ${round.outcome} transactions across ${round.evidence.blocks.length} blocks.`,
      );
    }
    round.lastError = forecastErrors.length ? forecastErrors.join(' ').slice(0, 240) : undefined;
    store.save(round);
  }

  async function tick() {
    for (const round of store.all()) {
      if (['SETTLED', 'CANCELLED'].includes(phase(round))) continue;
      try {
        await advance(round);
      } catch (error) {
        round.lastError =
          error instanceof Error
            ? error.message.split('\n')[0].slice(0, 240)
            : 'Round worker failed.';
        store.save(round);
      }
    }
  }
  async function cancelRound(id: string) {
    const round = store.get(id);
    if (!round) throw new Error('Round not found.');
    if (['SETTLED', 'CANCELLED'].includes(phase(round)))
      throw new Error('This round is already closed.');
    if (round.mode === 'onchain') {
      const address = round.contractAddress!;
      await assertOperator(address);
      const r = await rpc.readContract({
        address,
        abi,
        functionName: 'rounds',
        args: [BigInt(round.chainRoundId!)],
      });
      if (r[0] !== round.rulesHash && round.createTx) {
        const receipt = await rpc.getTransactionReceipt({ hash: round.createTx });
        if (receipt.status !== 'reverted')
          throw new Error('Confirm the round creation transaction before cancelling.');
      }
      if (r[0] === round.rulesHash && !r[6])
        await send(address, 'cancel', [BigInt(round.chainRoundId!)], (hash) => {
          round.cancelTx = hash;
          store.save(round);
        });
    }
    round.cancelled = true;
    log(round, 'Round cancelled by the operator.');
  }
  return { exclusive, createRound, tick, cancelRound };
}
