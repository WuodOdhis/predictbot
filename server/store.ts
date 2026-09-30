import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import type { Round } from './domain.js';
import type { PublicUsage } from '../shared/public-access.js';

mkdirSync('data', { recursive: true, mode: 0o700 });
const db = new Database('data/arena.sqlite');
db.pragma('journal_mode = WAL');
db.exec(
  'CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL)',
);
db.exec(
  'CREATE TABLE IF NOT EXISTS public_usage (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)',
);
export function getPublicUsage(): PublicUsage | undefined {
  const row = db.prepare('SELECT body FROM public_usage WHERE id = 1').get() as
    { body: string } | undefined;
  return row ? JSON.parse(row.body) : undefined;
}
export function savePublicUsage(usage: PublicUsage) {
  db.prepare(
    'INSERT INTO public_usage VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
  ).run(JSON.stringify(usage));
}
const upsert = db.prepare(
  'INSERT INTO rounds VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
);
export function save(round: Round) {
  upsert.run(round.id, round.createdAt, JSON.stringify(round));
}
export function all(): Round[] {
  return (
    db.prepare('SELECT body FROM rounds ORDER BY created_at DESC, rowid DESC').all() as {
      body: string;
    }[]
  ).map((r) => JSON.parse(r.body));
}
export function get(id: string): Round | undefined {
  const row = db.prepare('SELECT body FROM rounds WHERE id = ?').get(id) as
    { body: string } | undefined;
  return row ? JSON.parse(row.body) : undefined;
}
