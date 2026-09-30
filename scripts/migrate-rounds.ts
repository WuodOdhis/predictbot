import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import '../server/network.js';
import { all } from '../server/store.js';
import { phase } from '../shared/domain.js';

const config = dotenv.parse(readFileSync('.env', 'utf8'));
if (!config.ADMIN_TOKEN) throw new Error('Configure the hosted operator token first.');
const records = all();
if (records.some((r) => !['SETTLED', 'CANCELLED'].includes(phase(r))))
  throw new Error('Finish the active local round before migration.');
const url = process.env.HOSTED_API_URL || 'https://predictbot-api.newtonesila.workers.dev';
const response = await fetch(`${url}/api/operator/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ADMIN_TOKEN}` },
  body: JSON.stringify(records),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Round migration failed: HTTP ${response.status}.`);
console.log(JSON.stringify(await response.json()));
