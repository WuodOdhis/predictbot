import 'dotenv/config';
import './network.js';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Evidence } from './domain.js';

export const botTestnet = defineChain({
  id: 968,
  name: 'BOT Testnet',
  nativeCurrency: { name: 'Test BOT', symbol: 'tBOT', decimals: 18 },
  rpcUrls: { default: { http: [process.env.BOT_RPC_URL || 'https://rpc.bohr.life'] } },
  blockExplorers: { default: { name: 'BOTScan', url: 'https://scan.bohr.life' } },
  testnet: true,
});
export const rpc = createPublicClient({
  chain: botTestnet,
  transport: http(undefined, { timeout: 15_000, retryCount: 2 }),
});
export const abi = parseAbi([
  'function operator() view returns (address)',
  'function nextRoundId() view returns (uint256)',
  'function rounds(uint256) view returns (bytes32 rulesHash, uint64 commitDeadline, uint64 revealDeadline, uint64 observationStart, uint64 observationEnd, bool settled, bool cancelled, uint256 outcome, bytes32 evidenceHash)',
  'function predictions(uint256, bytes32) view returns (address submitter, bytes32 commitment, uint256 value, bool revealed)',
  'function createRound(bytes32, uint64, uint64, uint64, uint64) returns (uint256)',
  'function commit(uint256, bytes32, bytes32)',
  'function reveal(uint256, bytes32, uint256, bytes32)',
  'function settle(uint256, uint256, bytes32)',
  'function cancel(uint256)',
]);
export function signer() {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error('Configure a valid testnet DEPLOYER_PRIVATE_KEY in .env.');
  const account = privateKeyToAccount(key as Hex);
  return createWalletClient({ account, chain: botTestnet, transport: http() });
}
export function contractAddress(): Hex {
  const address = process.env.ARENA_CONTRACT_ADDRESS;
  if (!address || !isAddress(address))
    throw new Error('Deploy the contract and configure ARENA_CONTRACT_ADDRESS.');
  return address;
}
export async function assertTestnet() {
  if ((await rpc.getChainId()) !== 968) throw new Error('RPC is not BOT testnet (968).');
}
export async function assertOperator(address: Hex) {
  await assertTestnet();
  const wallet = signer();
  const owner = await rpc.readContract({ address, abi, functionName: 'operator' });
  if (owner.toLowerCase() !== wallet.account.address.toLowerCase())
    throw new Error("Configured wallet is not this contract's operator.");
}
export async function send(
  address: Hex,
  functionName: 'createRound' | 'commit' | 'reveal' | 'settle' | 'cancel',
  args: readonly unknown[],
  onHash: (hash: Hex) => void,
) {
  // Simulate before signing; the server only sends to the configured arena contract.
  const wallet = signer();
  const { request } = await rpc.simulateContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account,
  } as any);
  const hash = await wallet.writeContract(request);
  onHash(hash);
  const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 45_000 });
  if (receipt.status !== 'success') throw new Error('Contract transaction reverted.');
  return hash;
}
export async function recentStats() {
  await assertTestnet();
  const latest = await rpc.getBlock();
  const size = latest.number < 24n ? Number(latest.number) + 1 : 24;
  const blocks = [];
  for (let i = size - 1; i >= 0; i--) {
    const block = await rpc.getBlock({ blockNumber: latest.number - BigInt(i) });
    blocks.push({
      number: block.number.toString(),
      timestamp: Number(block.timestamp),
      transactions: block.transactions.length,
    });
  }
  const elapsed = Math.max(1, blocks.at(-1)!.timestamp - blocks[0].timestamp);
  const counts = blocks.slice(1).map((b) => b.transactions);
  const total = counts.reduce((a, b) => a + b, 0);
  const sorted = [...counts].sort((a, b) => a - b);
  return {
    blocks,
    blockNumber: latest.number.toString(),
    blockHash: latest.hash,
    blockTimestamp: Number(latest.timestamp),
    meanRate: total / elapsed,
    medianRate: ((sorted[Math.floor(sorted.length / 2)] || 0) * counts.length) / elapsed,
  };
}

export async function lowerBoundTimestamp(
  target: number,
  latest: bigint,
  timestamp: (n: bigint) => Promise<number>,
): Promise<bigint> {
  let lo = 0n,
    hi = latest + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await timestamp(mid)) < target) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

export async function collectEvidence(start: number, end: number): Promise<Evidence> {
  await assertTestnet();
  const latest = await rpc.getBlock({ blockTag: 'latest' });
  // Keep a 12-block buffer so the end boundary is not at the unstable tip.
  if (latest.number < 12n) throw new Error('Waiting for testnet confirmations.');
  const safe = latest.number - 12n;
  const safeBlock = await rpc.getBlock({ blockNumber: safe });
  if (Number(safeBlock.timestamp) < end)
    throw new Error('Waiting for the observation end to have 12 confirmations.');
  const timestamp = async (n: bigint) => Number((await rpc.getBlock({ blockNumber: n })).timestamp);
  const first = await lowerBoundTimestamp(start, safe, timestamp);
  const boundary = await lowerBoundTimestamp(end, safe, timestamp);
  if (boundary - first > 6000n)
    throw new Error('Observation range exceeds prototype limit of 6,000 blocks.');
  const previous = first > 0n ? await rpc.getBlock({ blockNumber: first - 1n }) : null;
  const endBlock = await rpc.getBlock({ blockNumber: boundary });
  const blocks: Evidence['blocks'] = [];
  let parent = previous?.hash;
  for (let n = first; n < boundary; n += 6n) {
    const batch = Array.from(
      { length: Number(boundary - n < 6n ? boundary - n : 6n) },
      (_, i) => n + BigInt(i),
    );
    const results = await Promise.all(batch.map((blockNumber) => rpc.getBlock({ blockNumber })));
    for (const b of results) {
      if (parent && b.parentHash !== parent)
        throw new Error('Chain changed during collection; retrying.');
      if (Number(b.timestamp) < start || Number(b.timestamp) >= end)
        throw new Error('Block timestamps changed; retrying.');
      blocks.push({
        number: b.number.toString(),
        hash: b.hash,
        timestamp: Number(b.timestamp),
        transactions: b.transactions.length,
      });
      parent = b.hash;
    }
  }
  if (parent && endBlock.parentHash !== parent) throw new Error('End boundary changed; retrying.');
  const recheck = await rpc.getBlock({ blockNumber: boundary });
  if (recheck.hash !== endBlock.hash) throw new Error('Canonical boundary changed; retrying.');
  return {
    schema: 'forecast-arena/outcome-v1',
    chainId: 968,
    observationStart: start,
    observationEnd: end,
    collectedAt: Math.floor(Date.now() / 1000),
    source: process.env.BOT_RPC_URL ? 'Configured BOT testnet RPC' : 'https://rpc.bohr.life',
    method:
      'Count every transaction in canonical blocks with start <= block.timestamp < end; reverted transactions included. End boundary has at least 12 successor blocks.',
    previousBlock: previous
      ? {
          number: previous.number.toString(),
          hash: previous.hash,
          timestamp: Number(previous.timestamp),
        }
      : null,
    endBoundary: {
      number: endBlock.number.toString(),
      hash: endBlock.hash,
      timestamp: Number(endBlock.timestamp),
    },
    blocks,
    outcome: blocks.reduce((sum, b) => sum + b.transactions, 0),
  };
}
