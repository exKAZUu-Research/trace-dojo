import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll } from 'vitest';

interface NodeRunOptions {
  heap?: number;
  args?: string[];
  timeout?: number;
}

export function createNodeBundleRunner(): (source: string, options?: NodeRunOptions) => string {
  const bundles = new Map<string, string>();
  let directory: string | undefined;
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  return (source, { heap, args = [], timeout = 30_000 } = {}) => {
    let bundle = bundles.get(source);
    if (!bundle) {
      if (!directory) {
        mkdirSync('.tmp', { recursive: true });
        directory = mkdtempSync('.tmp/bundled-node-');
      }
      bundle = join(directory, `${bundles.size}.mjs`);
      execFileSync('bun', ['build', source, '--target=node', '--packages=external', '--outfile', bundle], {
        timeout: 30_000,
      });
      bundles.set(source, bundle);
    }
    const nodeOptions = heap === undefined ? [] : [`--max-old-space-size=${heap}`];
    return execFileSync('node', [...nodeOptions, bundle, ...args], { encoding: 'utf8', timeout });
  };
}
