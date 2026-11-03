import { expect, test } from 'vitest';

import { executeJavaProgram } from '../../src/java/execute';

/** Programs with whether Java 21 compiles and launches them, given a `Turtle` class, as the interpreter must. */
const programs: [name: string, runs: boolean, source: string][] = [
  [
    'valid',
    true,
    'class Main {\n  public static void main(String[] args) {\n    Turtle 亀 = new Turtle(); 亀.前に進む();\n  }\n  \n}',
  ],
  ['semicolon', false, 'class Main {\n  public static void main(String[] args) {\n    int 回数 = 1\n  }\n  \n}'],
  [
    'for-semicolon',
    false,
    'class Main {\n  public static void main(String[] args) {\n    for (int i = 0 i < 3; i++) {}\n  }\n  \n}',
  ],
  ['parenthesis', false, 'class Main {\n  public static void main(String[] args) {\n    if (true {}\n  }\n  \n}'],
  ['bracket', false, 'class Main {\n  public static void main(String[] args) {\n    int[] 数 = new int[3;\n  }\n  \n}'],
  ['brace', false, 'class Main { public static void main(String[] args) {'],
  ['string', false, 'class Main {\n  public static void main(String[] args) {\n    String 文 = "hello;\n  }\n  \n}'],
  ['character', false, "class Main {\n  public static void main(String[] args) {\n    char 字 = 'ab';\n  }\n  \n}"],
  ['empty-character', false, "class Main {\n  public static void main(String[] args) {\n    char 字 = '';\n  }\n  \n}"],
  ['comment', false, 'class Main {\n  public static void main(String[] args) {\n    /* unfinished\n  }\n  \n}'],
  ['fullwidth', false, 'class Main {\n  public static void main(String[] args) {\n    int 数 = 1；\n  }\n  \n}'],
  ['escape', false, 'class Main {\n  public static void main(String[] args) {\n    String text = "\\q";\n  }\n  \n}'],
  ['identifier', false, 'class Main {\n  public static void main(String[] args) {\n    int = 1;\n  }\n  \n}'],
  ['expression', false, 'class Main {\n  public static void main(String[] args) {\n    int 数 = ;\n  }\n  \n}'],
  ['statement', false, 'class Main {\n  public static void main(String[] args) {\n    1 + 2;\n  }\n  \n}'],
  ['variable', false, 'class Main {\n  public static void main(String[] args) {\n    亀.fd(1);\n  }\n  \n}'],
  ['class', false, 'class Main {\n  public static void main(String[] args) {\n    かめ 亀 = new かめ();\n  }\n  \n}'],
  ['method', false, 'class Main {\n  public static void main(String[] args) {\n    前に進む();\n  }\n  \n}'],
  [
    'receiver-method',
    false,
    'class Main {\n  public static void main(String[] args) {\n    Turtle 亀 = new Turtle(); 亀.前進する();\n  }\n  \n}',
  ],
  [
    'scope',
    false,
    'class Main {\n  public static void main(String[] args) {\n    for (int 回数 = 0; 回数 < 3; 回数++) {}\n    System.out.println(回数);\n  }\n  \n}',
  ],
  [
    'duplicate-variable',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 回数 = 1; int 回数 = 2;\n  }\n  \n}',
  ],
  [
    'duplicate-method',
    false,
    'class Main {\n  public static void main(String[] args) {\n    \n  }\n  static void 進む(int 数) {}\n  static void 進む(int 別名) {}\n}',
  ],
  [
    'duplicate-class',
    false,
    'class Main {\n  public static void main(String[] args) {\n    \n  }\n  \n}\nclass 亀 {}\nclass 亀 {}',
  ],
  ['boolean-value', false, 'class Main {\n  public static void main(String[] args) {\n    int 数 = true;\n  }\n  \n}'],
  ['condition', false, 'class Main {\n  public static void main(String[] args) {\n    while (1) {}\n  }\n  \n}'],
  [
    'string-value',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 数 = "hello";\n  }\n  \n}',
  ],
  ['narrowing', false, 'class Main {\n  public static void main(String[] args) {\n    int 数 = 1.5;\n  }\n  \n}'],
  [
    'binary-operator',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 数 = true + 1;\n  }\n  \n}',
  ],
  [
    'unary-operator',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 数 = 1; boolean 判定 = !数;\n  }\n  \n}',
  ],
  [
    'incomparable',
    false,
    'class Main {\n  public static void main(String[] args) {\n    boolean 判定 = 1 == true;\n  }\n  \n}',
  ],
  [
    'dereference',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 数 = 1; 数.fd(1);\n  }\n  \n}',
  ],
  [
    'final-assignment',
    false,
    'class Main {\n  public static void main(String[] args) {\n    final int 数 = 1; 数 = 2;\n  }\n  \n}',
  ],
  ['assignment-target', false, 'class Main {\n  public static void main(String[] args) {\n    1 = 2;\n  }\n  \n}'],
  [
    'arguments',
    false,
    'class Main {\n  public static void main(String[] args) {\n    進む();\n  }\n  static void 進む(int 数) {}\n}',
  ],
  [
    'argument-type',
    false,
    'class Main {\n  public static void main(String[] args) {\n    進む(true);\n  }\n  static void 進む(int 数) {}\n}',
  ],
  [
    'constructor',
    false,
    'class Main {\n  public static void main(String[] args) {\n    Turtle 亀 = new Turtle(true);\n  }\n  \n}',
  ],
  [
    'return-path',
    false,
    'class Main {\n  public static void main(String[] args) {\n    \n  }\n  static int 数(boolean 判定) { if (判定) return 1; }\n}',
  ],
  [
    'return-empty',
    false,
    'class Main {\n  public static void main(String[] args) {\n    \n  }\n  static int 数() { return; }\n}',
  ],
  ['return-value', false, 'class Main {\n  public static void main(String[] args) {\n    return 1;\n  }\n  \n}'],
  [
    'static-method',
    false,
    'class Main {\n  public static void main(String[] args) {\n    進む();\n  }\n  void 進む() {}\n}',
  ],
  [
    'static-field',
    false,
    'class Main {\n  public static void main(String[] args) {\n    System.out.println(回数);\n  }\n  int 回数 = 1;\n}',
  ],
  [
    'private-access',
    false,
    'class Main {\n  public static void main(String[] args) {\n    亀 相手 = new 亀(); System.out.println(相手.速さ);\n  }\n  \n}\nclass 亀 { private int 速さ = 1; }',
  ],
  ['missing-main', false, 'class Main {}'],
  ['nonstatic-main', false, 'class Main { public void main(String[] args) {} }'],
  [
    'uninitialized',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 回数; if (args.length > 0) 回数 = 1; System.out.println(回数);\n  }\n  \n}',
  ],
  [
    'unreachable',
    false,
    'class Main {\n  public static void main(String[] args) {\n    return; System.out.println(1);\n  }\n  \n}',
  ],
  ['else', false, 'class Main {\n  public static void main(String[] args) {\n    if (true) {}; else {}\n  }\n  \n}'],
  ['break', false, 'class Main {\n  public static void main(String[] args) {\n    break;\n  }\n  \n}'],
  ['continue', false, 'class Main {\n  public static void main(String[] args) {\n    continue;\n  }\n  \n}'],
  [
    'not-array',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int 数 = 1; System.out.println(数[0]);\n  }\n  \n}',
  ],
  [
    'array-dimension',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int[] 数 = new int[];\n  }\n  \n}',
  ],
  [
    'array-index',
    false,
    'class Main {\n  public static void main(String[] args) {\n    int[] 数 = {1}; System.out.println(数[true]);\n  }\n  \n}',
  ],
  ['foreach', false, 'class Main {\n  public static void main(String[] args) {\n    for (int 数 : 1) {}\n  }\n  \n}'],
  [
    'switch-case',
    false,
    'class Main {\n  public static void main(String[] args) {\n    switch (1) { case 1: break; case 1: break; }\n  }\n  \n}',
  ],
  [
    'switch-default',
    false,
    'class Main {\n  public static void main(String[] args) {\n    switch (1) { default: break; default: break; }\n  }\n  \n}',
  ],
  ['try', false, 'class Main {\n  public static void main(String[] args) {\n    try {}\n  }\n  \n}'],
  ['catch', false, 'class Main {\n  public static void main(String[] args) {\n    catch (Exception e) {}\n  }\n  \n}'],
  [
    'checked-exception',
    false,
    'class Main {\n  public static void main(String[] args) {\n    throw new Exception();\n  }\n  \n}',
  ],
  [
    'override-return',
    false,
    'class Main {\n  public static void main(String[] args) {\n    \n  }\n  \n}\nclass 親 { int 数() { return 1; } }\nclass 子 extends 親 { String 数() { return "a"; } }',
  ],
  [
    'ifElse',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length > 0) x = 1; else x = 2; System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'ifNoElse',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length > 0) x = 1; System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'whileTrueBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { x = 1; break; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'whileCond',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (args.length > 0) { x = 1; break; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'forNoCond',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; for (;;) { x = 2; break; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'doWhile',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; do { x = 1; } while (args.length > 5); System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'andCond',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length > 0 && (x = 3) > 0) System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'orCondBad',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length > 0 || (x = 3) > 0) System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'orCondElse',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length == 0 || (x = 3) < 0) {} else System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'switchAll',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; switch (args.length) { case 0: x = 1; break; default: x = 2; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'switchNoDefault',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; switch (args.length) { case 0: x = 1; break; case 1: x = 2; break; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'switchFall',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; switch (args.length) { case 0: case 1: x = 1; break; default: x = 3; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'switchArrow',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; switch (args.length) { case 0 -> x = 1; default -> x = 2; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'tryCatch',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; try { x = Integer.parseInt("1"); } catch (RuntimeException e) { x = 0; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'tryCatchBad',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; try { x = Integer.parseInt("1"); } catch (RuntimeException e) { } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'tryFinally',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; try { System.out.println(1); } finally { x = 1; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'catchRead',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; try { x = 1; } catch (RuntimeException e) { System.out.println(x); }\n  }\n  \n}\n',
  ],
  [
    'returnPath',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length > 0) { x = 1; } else { return; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'throwPath',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (args.length > 0) { x = 1; } else { throw new RuntimeException(); } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'ifFalse',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; if (false) { System.out.println(x); }\n  }\n  \n}\n',
  ],
  [
    'whileFalseBad',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (args.length < 0) { System.out.println(x); }\n  }\n  \n}\n',
  ],
  [
    'labeled',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; outer: { if (args.length > 0) { x = 1; break outer; } x = 2; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'labeledLoop',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; outer: while (true) { while (true) { x = 1; break outer; } } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'compound',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; x += 1;\n  }\n  \n}\n',
  ],
  [
    'increment',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; x++;\n  }\n  \n}\n',
  ],
  [
    'ternary',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; int y = args.length > 0 ? (x = 1) : (x = 2); System.out.println(x + y);\n  }\n  \n}\n',
  ],
  [
    'finalOnce',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; x = 1; System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finalTwice',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; x = 1; x = 2;\n  }\n  \n}\n',
  ],
  [
    'finalBranches',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; if (args.length > 0) x = 1; else x = 2; System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finalLoop',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; while (args.length > 0) { x = 1; }\n  }\n  \n}\n',
  ],
  [
    'finalInit',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x = 1; x = 2;\n  }\n  \n}\n',
  ],
  [
    'finalParam',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    \n  }\n  static void f(final int a) { a = 1; }\n}\n',
  ],
  [
    'param',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    \n  }\n  static void f(int a) { a = 1; System.out.println(a); }\n}\n',
  ],
  [
    'forEachVar',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int[] a = {1}; for (int v : a) { System.out.println(v); }\n  }\n  \n}\n',
  ],
  [
    'forInit',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    for (int i = 0, j; i < 3; i++) { j = i; System.out.println(j); }\n  }\n  \n}\n',
  ],
  [
    'arrayElem',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int[] a; a = new int[2]; a[0] = 1; System.out.println(a[0]);\n  }\n  \n}\n',
  ],
  [
    'arrayUninit',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int[] a; a[0] = 1;\n  }\n  \n}\n',
  ],
  [
    'instanceInit',
    true,
    'public class Main { int f; { int x; x = 1; f = x; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'ctor',
    true,
    'public class Main { int f; Main(int v) { int y; if (v > 0) y = 1; else y = 2; f = y; } public static void main(String[] a) { new Main(1); } }',
  ],
  [
    'checkedThrow',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    throw new Exception();\n  }\n  \n}\n',
  ],
  [
    'checkedDeclared',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    \n  }\n  static void f() throws Exception { throw new Exception("x"); }\n}\n',
  ],
  [
    'checkedCaught',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { throw new Exception(); } catch (Exception e) { System.out.println(e); }\n  }\n  \n}\n',
  ],
  [
    'checkedCall',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    f();\n  }\n  static void f() throws Exception { }\n}\n',
  ],
  [
    'checkedCallCaught',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { f(); } catch (Exception e) { }\n  }\n  static void f() throws Exception { }\n}\n',
  ],
  [
    'checkedSubclass',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { f(); } catch (Exception e) { }\n  }\n  static void f() throws MyEx { }\n  \n}\nclass MyEx extends Exception {}\n',
  ],
  [
    'checkedWrongCatch',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { f(); } catch (RuntimeException e) { }\n  }\n  static void f() throws Exception { }\n}\n',
  ],
  [
    'rethrow',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { System.out.println(1); } catch (Exception e) { throw e; }\n  }\n  \n}\n',
  ],
  [
    'rethrowChecked',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { f(); } catch (Exception e) { throw e; }\n  }\n  static void f() throws Exception { }\n}\n',
  ],
  [
    'ctorThrows',
    false,
    'public class Main { Main() throws Exception {} public static void main(String[] a) { new Main(); } }',
  ],
  [
    'throwableThrow',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    throw new Throwable();\n  }\n  \n}\n',
  ],
  [
    'errorThrow',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    throw new Error();\n  }\n  \n}\n',
  ],
  [
    'nestedTry',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { try { throw new Exception(); } finally { } } catch (Exception e) { }\n  }\n  \n}\n',
  ],
  [
    'catchInCatch',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { throw new Exception(); } catch (Exception e) { throw new Exception(); }\n  }\n  \n}\n',
  ],
  [
    'rethrowReassigned',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { System.out.println(1); } catch (Exception e) { e = new Exception(); throw e; }\n  }\n  \n}\n',
  ],
  [
    'rethrowNarrow',
    true,
    'public class Main { static void f() throws MyEx {} public static void main(String[] a) throws MyEx { try { f(); } catch (Exception e) { throw e; } } }\nclass MyEx extends Exception {}\n',
  ],
  [
    'innerCaught',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { try { throw new Exception(); } catch (Exception e) { } } catch (RuntimeException e) { }\n  }\n  \n}\n',
  ],
  [
    'outerRethrow',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { try { f(); } finally { } } catch (Exception e) { throw e; }\n  }\n  static void f() throws Exception { }\n}\n',
  ],
  [
    'whileTrueNoBreak',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { if (args.length > 0) break; x = 1; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'continueLoop',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; for (int i = 0; i < 3; i++) { if (i == 0) continue; x = i; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'switchInLoopBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { switch (args.length) { case 0: break; default: break; } x = 1; break; } System.out.println(x);\n  }\n  \n}\n',
  ],
];

test.each(programs)('%s is accepted exactly when Java accepts it', (_, runs, source) => {
  const execution = executeJavaProgram(source);
  if (runs) {
    expect(execution.kind).not.toBe('compileError');
    return;
  }
  expect(execution).toMatchObject({ kind: 'compileError' });
  const lineCount = source.split('\n').length;
  for (const { row } of execution.kind === 'compileError' ? execution.diagnostics : []) {
    expect(row).toBeLessThan(lineCount);
  }
});

test('a missing semicolon is reported on the line that lacks it', () => {
  const source =
    'class Main {\n  public static void main(String[] args) {\n    int count = 0;\n    count++\n\n    count++;\n  }\n}';
  expect(executeJavaProgram(source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: '「;」が足りません。' }],
  });
});
