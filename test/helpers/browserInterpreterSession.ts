import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { type BrowserServer, chromium, firefox, type Page, webkit } from 'playwright';

const BROWSER_TYPES = { chromium, firefox, webkit };
type BrowserEngine = keyof typeof BROWSER_TYPES;

// CI installs Chromium alone; `BROWSER_ENGINES=chromium,firefox,webkit` compares the other engines where installed.
export const browserEngines = (process.env.BROWSER_ENGINES ?? 'chromium').split(',') as BrowserEngine[];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

export interface BrowserInterpreterSession {
  page: Page;
  close: () => Promise<void>;
}

/**
 * Bundles the interpreter worker with a page script for browsers, serves them, and opens the page in a browser.
 *
 * @param pageScript An entry of `test/helpers/buildBrowserInterpreters.ts`, which sets `readyGlobal` once loaded.
 */
export async function openBrowserInterpreterPage(
  pageScript: string,
  readyGlobal: string,
  engine: BrowserEngine = 'chromium'
): Promise<BrowserInterpreterSession> {
  mkdirSync('.tmp', { recursive: true });
  const bundleDirectory = mkdtempSync('.tmp/browser-interpreters-');
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname === '/') {
      response.setHeader('Content-Type', CONTENT_TYPES['.html']);
      response.end(`<script type="module" src="/${pageScript.replace(/\.ts$/, '.js')}"></script>`);
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
  let browserServer: BrowserServer | undefined;
  const close = async (): Promise<void> => {
    // Chromium takes 10 seconds to close after a page terminated a worker, and there is no state to save.
    await browserServer?.kill();
    server.close();
    rmSync(bundleDirectory, { recursive: true });
  };
  try {
    execFileSync('bun', ['test/helpers/buildBrowserInterpreters.ts', bundleDirectory], { stdio: 'inherit' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browserType = BROWSER_TYPES[engine];
    browserServer = await browserType.launchServer();
    const browser = await browserType.connect(browserServer.wsEndpoint());
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await page.waitForFunction((name) => name in globalThis, readyGlobal);
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
