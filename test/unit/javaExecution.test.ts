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
  [
    'a huge repeated string',
    main('String s = "x".repeat(2000000000);'),
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
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
    'endless recursion through nested statements',
    'public class Main { static int f(int n) { for (int i = 0; i < 2; i++) { if (n >= 0) { try { while (true) { n += f(n + 1); break; } } finally { } } } return n; } public static void main(String[] a) { f(0); } }',
    { kind: 'executed', uncaughtException: 'java.lang.StackOverflowError' },
  ],
  [
    'an uncaught exception whose toString() throws',
    'class Main { public static void main(String[] a) { throw new E(); } } class E extends RuntimeException { public String toString() { throw new RuntimeException(); } }',
    { kind: 'executed', uncaughtException: 'E' },
  ],
  [
    'an uncaught exception whose toString() recurses endlessly',
    'class Main { public static void main(String[] a) { throw new E(); } } class E extends RuntimeException { static int f(int n) { for (int i = 0; i < 2; i++) { if (n >= 0) { try { while (true) { n += f(n + 1); break; } } finally { } } } return n; } public String toString() { f(0); return "E"; } }',
    { kind: 'executed', uncaughtException: 'E' },
  ],
  [
    'a search for an invalid code point',
    main('Turtle t = new Turtle(); if ("abc".indexOf(-1) == -1 && "abc".indexOf(0x110000) == -1) t.前に進む();'),
    { kind: 'executed', finalTurtles: [{ x: 0, y: 1, color: '#', dir: 'N' }], uncaughtException: undefined },
  ],
  [
    'trimming a string with a long run of inner spaces',
    main('String s = "x" + " ".repeat(900000) + "y"; System.out.println(s.trim().length());'),
    { kind: 'executed', uncaughtException: undefined },
  ],
  [
    'case-insensitive comparisons with a long non-ASCII string',
    main('String s = "İ".repeat(900000); int n = 0; while (true) { if ("a".equalsIgnoreCase(s)) n++; }'),
    { kind: 'limitExceeded' },
  ],
  [
    'parsing a long string repeatedly',
    main('String s = "0".repeat(900000) + "1"; int n = 0; while (true) { n += Integer.parseInt(s); }'),
    { kind: 'limitExceeded', limit: 'operations' },
  ],
  [
    'many copies of a long exception description',
    main(
      'RuntimeException e = new RuntimeException("x".repeat(1000000)); String[] a = new String[30]; for (int i = 0; i < a.length; i++) a[i] = e.toString();'
    ),
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
  [
    'many exceptions echoing a long input',
    main(
      'String s = "x".repeat(1000000); Exception[] a = new Exception[30]; for (int i = 0; i < a.length; i++) { try { Integer.parseInt(s); } catch (NumberFormatException e) { a[i] = e; } }'
    ),
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
  [
    'building a string by appending one character at a time',
    main('String s = ""; for (int i = 0; i < 4500; i++) s = s + "x"; System.out.println(s.length());'),
    { kind: 'executed', uncaughtException: undefined },
  ],
  [
    'a turtle kept alive only through an exception cause',
    'class E extends Exception { Turtle t = new Turtle(); } class Main { public static void main(String[] a) { Exception e = new Exception(new E()); } }',
    { kind: 'executed', finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }], uncaughtException: undefined },
  ],
  [
    'a huge array',
    main('int[][] a = new int[100000][100000];'),
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
  [
    'a large array kept alive with a turtle',
    main('Turtle t = new Turtle(); int[] a = new int[900000];'),
    { kind: 'executed', finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }], uncaughtException: undefined },
  ],
  [
    'garbage collections over a large array',
    main('Turtle t = new Turtle(); Object[] a = new Object[900000]; while (true) t.前に進めるか();'),
    { kind: 'limitExceeded' },
  ],
  [
    'a search for a long pattern in a long string',
    main(
      'String a = "a".repeat(900000); String p = "a".repeat(4000) + "b" + "a".repeat(4000); System.out.println(a.indexOf(p));'
    ),
    { kind: 'limitExceeded' },
  ],
  [
    'many objects with many fields',
    `class Item { ${Array.from({ length: 1000 }, (_, index) => `int a${index};`).join(' ')} }\n${main(
      'Item[] a = new Item[10000]; for (int i = 0; i < a.length; i++) a[i] = new Item();'
    )}`,
    { kind: 'executed', uncaughtException: expect.stringContaining('OutOfMemoryError') },
  ],
  ['deeply nested blocks', main(`${'{'.repeat(9000)}${'}'.repeat(9000)}`), { kind: 'compileError' }],
  ['deeply nested negations', main(`boolean b = ${'!'.repeat(19_000)}true;`), { kind: 'compileError' }],
])('%s ends within the limits', (_, source, expected) => {
  const startedAt = performance.now();
  expect(executeJavaProgram(source)).toMatchObject(expected);
  expect(performance.now() - startedAt).toBeLessThan(5000);
});
