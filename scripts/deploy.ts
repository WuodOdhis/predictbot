import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { assertTestnet, rpc, signer } from '../server/chain.js';

await assertTestnet();
const wallet = signer();
const artifact = JSON.parse(readFileSync('out/ForecastArena.sol/ForecastArena.json', 'utf8'));
const balance = await rpc.getBalance({ address: wallet.account.address });
if (balance === 0n)
  throw new Error(`Fund ${wallet.account.address} using https://faucet.botchain.ai/basic first.`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
console.log(`Deployment submitted: https://scan.bohr.life/tx/${hash}`);
const receipt = await rpc.waitForTransactionReceipt({ hash, confirmations: 2 });
if (receipt.status !== 'success' || !receipt.contractAddress)
  throw new Error('Deployment did not succeed.');
console.log(`ARENA_CONTRACT_ADDRESS=${receipt.contractAddress}`);
console.log(`Contract: https://scan.bohr.life/address/${receipt.contractAddress}`);
