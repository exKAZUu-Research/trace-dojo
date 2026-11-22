import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { browserReadyInterpreters, type BrowserReadyLanguage } from '../../src/interpreter/browserReadyInterpreters';
import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { SAMPLE_PROGRAMS } from '../helpers/browserInterpreterSamples';
import { type BrowserInterpreterSession, openBrowserInterpreterPage } from '../helpers/browserInterpreterSession';

let session: BrowserInterpreterSession;
let page: Page;

beforeAll(async () => {
  session = await openBrowserInterpreterPage('test/helpers/browserInterpreterPage.ts', 'createRunner');
  ({ page } = session);
}, 120_000);

afterAll(async () => {
  await session?.close();
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
