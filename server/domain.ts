import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';

export type Phase = 'COMMIT' | 'REVEAL' | 'OBSERVING' | 'AWAITING_RESULT' | 'SETTLED' | 'CANCELLED';
export interface Forecast {
  id: string;
  name: string;
  kind: 'baseline' | 'model';
  model?: string;
  value: number;
  salt: Hex;
  reasoning: string;
  commitment?: Hex;
  committedAt?: number;
  revealedAt?: number;
  failure?: string;
  commitTx?: Hex;
  revealTx?: Hex;
}
export interface Round {
  id: string;
  mode: 'practice' | 'onchain';
  createdAt: number;
  commitDeadline: number;
  revealDeadline: number;
  observationStart: number;
  observationEnd: number;
  rules: string;
  rulesHash: Hex;
  forecasts: Forecast[];
  cancelled: boolean;
  outcome?: number;
  evidenceHash?: Hex;
  evidence?: Evidence;
  lastError?: string;
  chainRoundId?: string;
  contractAddress?: Hex;
  createTx?: Hex;
  settleTx?: Hex;
  cancelTx?: Hex;
  commitmentDomain?: { chainId: number; contract: Hex; roundId: string; submitter: Hex };
  activity: { at: number; message: string }[];
}
export interface Evidence {
  schema: 'forecast-arena/outcome-v1';
  chainId: 968;
  observationStart: number;
  observationEnd: number;
  collectedAt: number;
  source: string;
  method: string;
  previousBlock: { number: string; hash: Hex; timestamp: number } | null;
  endBoundary: { number: string; hash: Hex; timestamp: number };
  blocks: { number: string; hash: Hex; timestamp: number; transactions: number }[];
  outcome: number;
}
export function phase(round: Round, now = Math.floor(Date.now() / 1000)): Phase {
  if (round.cancelled) return 'CANCELLED';
  if (round.outcome !== undefined) return 'SETTLED';
  if (now < round.commitDeadline) return 'COMMIT';
  if (now < round.revealDeadline) return 'REVEAL';
  if (now < round.observationEnd) return 'OBSERVING';
  return 'AWAITING_RESULT';
}
export function digest(value: string): Hex {
  return keccak256(stringToHex(value));
}
export function makeCommitment(
  chain: number,
  contract: Hex,
  roundId: bigint,
  agentId: Hex,
  submitter: Hex,
  value: number,
  salt: Hex,
): Hex {
  return keccak256(
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
      [BigInt(chain), contract, roundId, agentId, submitter, BigInt(value), salt],
    ),
  );
}
export function publicRound(round: Round, now = Math.floor(Date.now() / 1000)) {
  return {
    ...round,
    evidence: undefined,
    phase: phase(round, now),
    forecasts: round.forecasts.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      model: f.model,
      commitment: f.commitment,
      committedAt: f.committedAt,
      revealedAt: f.revealedAt,
      commitTx: f.commitTx,
      revealTx: f.revealTx,
      failure: f.failure,
      value: f.revealedAt ? f.value : undefined,
      reasoning: f.revealedAt ? f.reasoning : undefined,
      revealSalt: f.revealedAt ? f.salt : undefined,
      error:
        f.revealedAt && round.outcome !== undefined ? Math.abs(f.value - round.outcome) : undefined,
    })),
  };
}
