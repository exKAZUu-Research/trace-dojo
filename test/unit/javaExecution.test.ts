import { expect, test } from 'vitest';

import { executeJavaProgram } from '../../src/java/execute';

const main = (body: string): string =>
  `public class Main {\n  public static void main(String[] args) {\n    ${body}\n  }\n}`;

test.each([
  ['an endless loop', main('while (true) {}'), { kind: 'limitExceeded' }],
  ['endless output', main('while (true) System.out.println("x");'), { kind: 'limitExceeded', limit: 'output' }],
  [
    'a doubling string',
    main('String s = "x"; while (true) s = s + s;'),
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
  ['a huge repeated string', main('String s = "x".repeat(2000000000);'), { kind: 'limitExceeded' }],
  [
    'many comparisons of long strings',
    main('String a = "x".repeat(100000); String b = "x".repeat(100000); int n = 0; while (true) if (a.equals(b)) n++;'),
    { kind: 'limitExceeded' },
  ],
  [
    'endless recursion',
    'public class Main { static void f() { f(); } public static void main(String[] a) { f(); } }',
    { kind: 'executed', uncaughtException: expect.stringContaining('StackOverflowError') },
  ],
  [
    'a huge array',
    main('int[][] a = new int[100000][100000];'),
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
  ['deeply nested blocks', main(`${'{'.repeat(9000)}${'}'.repeat(9000)}`), { kind: 'compileError' }],
  ['deeply nested negations', main(`boolean b = ${'!'.repeat(19_000)}true;`), { kind: 'compileError' }],
])('%s ends within the limits', (_, source, expected) => {
  const startedAt = performance.now();
  expect(executeJavaProgram(source)).toMatchObject(expected);
  expect(performance.now() - startedAt).toBeLessThan(5000);
});
