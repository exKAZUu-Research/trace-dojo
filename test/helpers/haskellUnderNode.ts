import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll } from 'vitest';

const bundles = new Map<string, string>();
let directory: string | undefined;

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

export function runHaskellUnderNode(path: string, heap?: number, args: string[] = [], timeout = 30_000): string {
  const flags = heap === undefined ? [] : [`--max-old-space-size=${heap}`];
  return execFileSync('node', [...flags, bundleFor(path), ...args], { encoding: 'utf8', timeout });
}

function bundleFor(path: string): string {
  const existing = bundles.get(path);
  if (existing) return existing;
  if (!directory) {
    const temporary = resolve('.tmp');
    mkdirSync(temporary, { recursive: true });
    directory = mkdtempSync(join(temporary, 'haskell-node-'));
  }
  const bundle = join(directory, `${bundles.size}.mjs`);
  execFileSync('bun', ['build', path, '--target=node', '--packages=external', '--outfile', bundle], {
    timeout: 30_000,
  });
  bundles.set(path, bundle);
  return bundle;
}
