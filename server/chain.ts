import 'dotenv/config';
import './network.js';
import { createChain } from '../shared/chain.js';

export const {
  botTestnet,
  rpc,
  abi,
  signer,
  contractAddress,
  assertTestnet,
  assertOperator,
  send,
  recentStats,
  lowerBoundTimestamp,
  collectEvidence,
} = createChain(process.env);
