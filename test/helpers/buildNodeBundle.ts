import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function buildNodeBundle(entry: string): string {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'node-bundle-'));
  const output = join(directory, 'bundle.mjs');
  try {
    execFileSync('bun', ['build', entry, '--target=node', '--packages=external', '--outfile', output], {
      timeout: 30_000,
    });
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
