import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { digest, makeCommitment } from './domain.js';

test(
  'SDK signs, confirms, reveals and settles against a real local EVM',
  { timeout: 60_000 },
  async () => {
    const port = 18545;
    const anvil = spawn(
      'anvil',
      [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--chain-id',
        '968',
        '--block-time',
        '1',
        '--silent',
      ],
      { stdio: 'ignore' },
    );
    let spawnError: Error | undefined;
    anvil.on('error', (e) => {
      spawnError = e;
    });
    const oldRpc = process.env.BOT_RPC_URL,
      oldKey = process.env.DEPLOYER_PRIVATE_KEY;
    try {
      const url = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (spawnError) throw spawnError;
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          });
          ready = response.ok;
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'Local Anvil did not start.');
      process.env.BOT_RPC_URL = url;
      process.env.DEPLOYER_PRIVATE_KEY = generatePrivateKey();
      const { rpc, signer, send, abi, assertOperator } = await import('./chain.js');
      const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
      const localRequest = async (method: string, params: unknown[]) => {
        const result = (await (
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        ).json()) as { error?: unknown };
        assert.equal(result.error, undefined);
      };
      await localRequest('anvil_setBalance', [account.address, '0x56bc75e2d63100000']);
      const artifact = JSON.parse(readFileSync('out/ForecastArena.sol/ForecastArena.json', 'utf8'));
      const hash = await signer().deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
      });
      const deployment = await rpc.waitForTransactionReceipt({ hash, confirmations: 2 });
      assert.equal(deployment.status, 'success');
      const address = deployment.contractAddress!;
      await assertOperator(address);
      const timestamp = Number((await rpc.getBlock()).timestamp);
      const rules = digest('local test rules');
      let recordedHash: string | undefined;
      await send(
        address,
        'createRound',
        [rules, timestamp + 60, timestamp + 120, timestamp + 120, timestamp + 180],
        (tx) => {
          recordedHash = tx;
        },
      );
      assert.match(recordedHash!, /^0x[0-9a-f]{64}$/);
      const agent = digest('test-agent'),
        salt = digest('test-secret');
      const commitment = makeCommitment(968, address, 1n, agent, account.address, 42, salt);
      await send(address, 'commit', [1n, agent, commitment], () => {});
      await localRequest('evm_increaseTime', [61]);
      await localRequest('evm_mine', []);
      await send(address, 'reveal', [1n, agent, 42n, salt], () => {});
      const prediction = await rpc.readContract({
        address,
        abi,
        functionName: 'predictions',
        args: [1n, agent],
      });
      assert.equal(prediction[2], 42n);
      assert.equal(prediction[3], true);
      await localRequest('evm_increaseTime', [121]);
      await localRequest('evm_mine', []);
      const evidence = digest('local test evidence');
      await send(address, 'settle', [1n, 0n, evidence], () => {});
      const round = await rpc.readContract({ address, abi, functionName: 'rounds', args: [1n] });
      assert.equal(round[5], true);
      assert.equal(round[7], 0n);
      assert.equal(round[8], evidence);
    } finally {
      if (oldRpc === undefined) delete process.env.BOT_RPC_URL;
      else process.env.BOT_RPC_URL = oldRpc;
      if (oldKey === undefined) delete process.env.DEPLOYER_PRIVATE_KEY;
      else process.env.DEPLOYER_PRIVATE_KEY = oldKey;
      if (anvil.exitCode === null && anvil.pid) {
        anvil.kill('SIGTERM');
        await once(anvil, 'exit');
      }
    }
  },
);
