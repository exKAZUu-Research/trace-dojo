import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { type BrowserServer, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { browserReadyInterpreters, type BrowserReadyLanguage } from '../../src/interpreter/browserReadyInterpreters';
import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { SAMPLE_PROGRAMS } from '../helpers/browserInterpreterSamples';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

let bundleDirectory: string;
let server: Server;
let browserServer: BrowserServer;
let page: Page;

beforeAll(async () => {
  mkdirSync('.tmp', { recursive: true });
  bundleDirectory = mkdtempSync('.tmp/browser-interpreters-');
  execFileSync('bun', ['test/helpers/buildBrowserInterpreters.ts', bundleDirectory], { stdio: 'inherit' });
  server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname === '/') {
      response.setHeader('Content-Type', CONTENT_TYPES['.html']);
      response.end('<script type="module" src="/test/helpers/browserInterpreterPage.js"></script>');
      return;
    }
    // The grammars stay in `node_modules`, where the bundle refers to them.
    const file = path.join(pathname.startsWith('/node_modules/') ? '.' : bundleDirectory, pathname);
    if (!existsSync(file)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)]);
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  browserServer = await chromium.launchServer();
  const browser = await chromium.connect(browserServer.wsEndpoint());
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await page.waitForFunction(() => 'createRunner' in globalThis);
}, 120_000);

afterAll(async () => {
  // Chromium takes 10 seconds to close after a page terminated a worker, and there is no state to save.
  await browserServer?.kill();
  server?.close();
  if (bundleDirectory) rmSync(bundleDirectory, { recursive: true });
});

test.each(Object.keys(browserReadyInterpreters) as BrowserReadyLanguage[])(
  'a browser runs and traces a %s program as Node.js does',
  async (language) => {
    const source = SAMPLE_PROGRAMS[language];
    const [execution, trace] = await page.evaluate(
      async ([language, source]) => {
        const runner = globalThis.createRunner();
        try {
          return [
            await runner.executeProgram(language, source),
            await runner.traceProgram(language, source, source),
          ] as const;
        } finally {
          runner.terminate();
        }
      },
      [language, source] as const
    );
    expect(execution).toMatchObject({ kind: 'executed' });
    expect(execution.kind === 'executed' && execution.stdout + execution.stderr).toBe('42\n');
    expect(execution).toEqual(executeProgram(language, source));
    expect(trace).toEqual(traceProgram(language, source, source));
  },
  60_000
);

test('the runner stops a program that outlasts the wall-clock limit and runs the next one', async () => {
  const endless = `public class Main {
  public static void main(String[] args) {
    while (true) {}
  }
}`;
  const [reason, execution] = await page.evaluate(
    async ([endless, sample]) => {
      const runner = globalThis.createRunner();
      try {
        const reason = await runner.executeProgram('java', endless, undefined, { timeoutMs: 1 }).then(
          () => 'finished',
          (error: unknown) => (error as { reason?: string }).reason
        );
        return [reason, await runner.executeProgram('java', sample)] as const;
      } finally {
        runner.terminate();
      }
    },
    [endless, SAMPLE_PROGRAMS.java] as const
  );
  expect(reason).toBe('timeout');
  expect(execution).toMatchObject({ kind: 'executed', stdout: '42\n' });
}, 60_000);
