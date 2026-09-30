import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';

const source = readFileSync('.env', 'utf8');
const config = dotenv.parse(source);
if (!config.GROQ_API_KEY || !config.DEPLOYER_PRIVATE_KEY)
  throw new Error('Configure the model key and testnet wallet locally first.');
let token = config.ADMIN_TOKEN;
if (!token) {
  token = randomBytes(32).toString('hex');
  const updated = /^ADMIN_TOKEN=.*$/m.test(source)
    ? source.replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${token}`)
    : source + (source.endsWith('\n') ? '' : '\n') + `ADMIN_TOKEN=${token}\n`;
  writeFileSync('.env', updated, { mode: 0o600 });
}
chmodSync('.env', 0o600);
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], {
  env: { ...process.env, NODE_OPTIONS: '--no-network-family-autoselection' },
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end(
  JSON.stringify({
    GROQ_API_KEY: config.GROQ_API_KEY,
    DEPLOYER_PRIVATE_KEY: config.DEPLOYER_PRIVATE_KEY,
    ADMIN_TOKEN: token,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173',
  }),
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code || 0;
});
