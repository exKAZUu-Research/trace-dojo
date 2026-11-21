import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll } from 'vitest';

interface RunOptions {
  heapMb?: number;
  timeout?: number;
  args?: string[];
}

export function createNodeBundleRunner(): (entry: string, options?: RunOptions) => string {
  let directory: string | undefined;
  const bundles = new Map<string, string>();

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true });
  });

  return (entry, { heapMb, timeout = 30_000, args = [] } = {}) => {
    let bundle = bundles.get(entry);
    if (bundle === undefined) {
      if (directory === undefined) {
        mkdirSync('.tmp', { recursive: true });
        directory = mkdtempSync('.tmp/node-bundle-');
      }
      bundle = join(directory, `${bundles.size}.mjs`);
      execFileSync('bun', ['build', entry, '--target=node', '--packages=external', '--outfile', bundle], {
        timeout: 30_000,
      });
      bundles.set(entry, bundle);
    }
    return execFileSync(
      'node',
      [...(heapMb === undefined ? [] : [`--max-old-space-size=${heapMb}`]), bundle, ...args],
      {
        encoding: 'utf8',
        timeout,
      }
    );
  };
}
