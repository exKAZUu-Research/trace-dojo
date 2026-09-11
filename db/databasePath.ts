import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function databasePath(): string {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is not set');
  const path = process.env.DATABASE_URL.replace(/^file:/, '').split('?')[0];
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
