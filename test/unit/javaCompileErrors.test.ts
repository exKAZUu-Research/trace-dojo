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
  ['self-initializer', false, 'class Main { static int x; public static void main(String[] a) { int x = x; } }'],
  ['later-declarator', true, 'class Main { public static void main(String[] a) { int x = 1, y = x + 1; } }'],
  [
    'constFinalCond',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final boolean go = true; int n; if (go) n = 4; System.out.println(n);\n  }\n  \n}\n',
  ],
  [
    'constWhileUnreachable',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final boolean go = true; while (go) {} System.out.println(1);\n  }\n  \n}\n',
  ],
  [
    'staticConstWhile',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    while (GO) {} System.out.println(1);\n  }\n  static final boolean GO = true;\n}\n',
  ],
  [
    'nonConstFinal',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final boolean go = args.length > 0; int n; if (go) n = 1; System.out.println(n);\n  }\n  \n}\n',
  ],
  [
    'literalCompare',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    while (1 < 2) {} System.out.println(1);\n  }\n  \n}\n',
  ],
  [
    'constMissingReturn',
    true,
    'public class Main { static final boolean GO = true; static int f() { while (GO) {} } public static void main(String[] a) { f(); } }',
  ],
  [
    'laterRethrowCaught',
    true,
    'class A extends Exception {}\npublic class Main { static void f() throws A {} public static void main(String[] args) { try { f(); } catch (A a) { } catch (Exception e) { throw e; } } }\n',
  ],
  [
    'narrowRethrow',
    true,
    'class A extends Exception {}\npublic class Main { static void f() throws Exception {} public static void main(String[] args) throws A { try { f(); } catch (A e) { throw e; } catch (Exception e) { } } }\n',
  ],
  [
    'narrowRethrowBad',
    false,
    'class A extends Exception {}\nclass B extends A {}\npublic class Main { static void f() throws A {} public static void main(String[] args) throws B { try { f(); } catch (A e) { throw e; } } }\n',
  ],
  [
    'initializerConstantLoop',
    true,
    'public class Main { static int y; static { int x; while (true) { x = 1; break; } y = x; } { int z; if (true) z = 1; y = z; } public static void main(String[] args) { System.out.println(y); } }',
  ],
  [
    'finallyBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { try { break; } finally { x = 1; } } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finallyContinue',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; for (int i = 0; i < 2; i++) { try { if (i == 0) continue; } finally { x = i; } System.out.println(x); }\n  }\n  \n}\n',
  ],
  [
    'finallyBreakNoAssign',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { try { break; } finally { } } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'nestedFinally',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; outer: while (true) { try { try { break outer; } finally { } } finally { x = 2; } } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finalSelfAssign',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x = (x = 1);\n  }\n  \n}\n',
  ],
  [
    'nonFinalSelfAssign',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x = (x = 1); System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'breakInFinally',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { try { } finally { if (args.length == 0) break; x = 1; } } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'breakOnlyInFinally',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int x; while (true) { try { } finally { break; } } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finalCatchReturnFinally',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; try { throw new RuntimeException(); } catch (RuntimeException e) { x = 1; return; } finally { x = 2; }\n  }\n  \n}\n',
  ],
  [
    'finalTryOnly',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; try { x = 1; } finally { } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'ctorArgFinal',
    false,
    'class A { A(int n) {} }\npublic class Main extends A { Main(final int x) { super(x = 2); } public static void main(String[] a) { new Main(1); } }\n',
  ],
  [
    'ctorArgOk',
    true,
    'class A { A(int n) {} }\npublic class Main extends A { Main(int x) { super(x = 2); } public static void main(String[] a) { new Main(1); } }\n',
  ],
  [
    'finalDoFalse',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; do { x = 1; } while (false); System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finalWhileBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; while (true) { x = 1; break; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'finalAfterLoop',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; while (args.length > 0) { x = 1; } x = 2;\n  }\n  \n}\n',
  ],
  [
    'finalForLoop',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; for (int i = 0; i < 2; i++) { x = i; }\n  }\n  \n}\n',
  ],
  [
    'finalNestedLoop',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; while (true) { for (int i = 0; i < 1; i++) { x = 1; break; } }\n  }\n  \n}\n',
  ],
  [
    'finalContinue',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    final int x; while (args.length > 0) { x = 1; continue; }\n  }\n  \n}\n',
  ],
  [
    'finalInnerDecl',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    while (args.length > 0) { final int y; y = 1; System.out.println(y); }\n  }\n  \n}\n',
  ],
  [
    'neverThrown',
    false,
    'class E1 extends Exception {}\npublic class Main { public static void main(String[] args) { try { System.out.println(1); } catch (E1 e) { } } }\n',
  ],
  [
    'neverThrownMulti',
    false,
    'class E1 extends Exception {}\nclass E2 extends Exception {}\npublic class Main { static void f() throws E1 {} public static void main(String[] args) { try { f(); } catch (E1 | E2 e) { } } }\n',
  ],
  [
    'catchException',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { System.out.println(1); } catch (Exception e) { }\n  }\n  \n}\n',
  ],
  [
    'catchSuperOfThrown',
    true,
    'class E1 extends Exception {}\nclass E2 extends E1 {}\npublic class Main { static void f() throws E2 {} public static void main(String[] args) { try { f(); } catch (E1 e) { } } }\n',
  ],
  [
    'catchSubOfThrown',
    true,
    'class E1 extends Exception {}\nclass E2 extends E1 {}\npublic class Main { static void f() throws E1 {} public static void main(String[] args) { try { f(); } catch (E2 e) { } catch (E1 e) { } } }\n',
  ],
  [
    'innerConsumed',
    false,
    'class E1 extends Exception {}\npublic class Main { static void f() throws E1 {} public static void main(String[] args) { try { try { f(); } catch (E1 e) { } } catch (E1 e) { } } }\n',
  ],
  [
    'alreadyCaught',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { System.out.println(1); } catch (Exception e) { } catch (RuntimeException e) { }\n  }\n  \n}\n',
  ],
  [
    'alreadyCaughtChecked',
    false,
    'class E1 extends Exception {}\nclass E2 extends E1 {}\npublic class Main { static void f() throws E2 {} public static void main(String[] args) { try { f(); } catch (E1 e) { } catch (E2 e) { } } }\n',
  ],
  [
    'uncheckedNever',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    try { System.out.println(1); } catch (RuntimeException e) { }\n  }\n  \n}\n',
  ],
  [
    'arrayLength',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int[] arr = new int[2]; arr.length = 5;\n  }\n  \n}\n',
  ],
  [
    'arrayLengthInc',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int[] arr = new int[2]; arr.length++;\n  }\n  \n}\n',
  ],
  [
    'qualifiedConst',
    false,
    'public class Main { static final int F = 1; public static void main(String[] a) { Main.F = 2; } }',
  ],
  [
    'receiverConst',
    false,
    'public class Main { final int f = 1; public static void main(String[] a) { new Main().f = 2; } }',
  ],
  [
    'constIncrement',
    false,
    'public class Main { static final int F = 1; public static void main(String[] a) { F++; } }',
  ],
  [
    'blankFinalCtor',
    true,
    'public class Main { final int f; Main() { f = 1; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankFinalThis',
    true,
    'public class Main { final int f; Main() { this.f = 1; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankFinalMethod',
    false,
    'public class Main { final int f = 0; void g() { } final int h; Main() { h = 1; } void set() { h = 2; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankFinalOther',
    false,
    'public class Main { final int f; Main() { f = 1; Main m = this; m.f = 2; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankStaticFinal',
    true,
    'public class Main { static final int F; static { F = 3; } public static void main(String[] a) { System.out.println(F); } }',
  ],
  [
    'builtinConst',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    Integer.MAX_VALUE = 1;\n  }\n  \n}\n',
  ],
  ['returnInInit', false, 'public class Main { { return; } public static void main(String[] a) { } }'],
  ['returnInStaticInit', false, 'public class Main { static { return; } public static void main(String[] a) { } }'],
  [
    'returnInCtor',
    true,
    'public class Main { Main() { return; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankNeverAssigned',
    false,
    'public class Main { final int f; public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankOneCtorMissing',
    false,
    'public class Main { final int f; Main() { f = 1; } Main(int x) { } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankTwiceInCtor',
    false,
    'public class Main { final int f; Main() { f = 1; f = 2; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankViaThisCall',
    true,
    'public class Main { final int f; Main() { this(1); } Main(int x) { f = x; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankInInitializer',
    true,
    'public class Main { final int f; { f = 3; } Main() { } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankInitAndCtor',
    false,
    'public class Main { final int f; { f = 3; } Main() { f = 4; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankBranches',
    true,
    'public class Main { final int f; Main(boolean b) { if (b) f = 1; else f = 2; } public static void main(String[] a) { new Main(true); } }',
  ],
  [
    'blankReturnEarly',
    false,
    'public class Main { final int f; Main(boolean b) { if (b) return; f = 1; } public static void main(String[] a) { new Main(true); } }',
  ],
  [
    'blankReadBefore',
    false,
    'public class Main { final int f; Main() { System.out.println(f); f = 1; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankReadThisBefore',
    false,
    'public class Main { final int f; Main() { System.out.println(this.f); f = 1; } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'blankParamShadow',
    true,
    'public class Main { final int f; Main(int f) { this.f = f; } public static void main(String[] a) { new Main(1); } }',
  ],
  ['staticBlankMissing', false, 'public class Main { static final int F; public static void main(String[] a) { } }'],
  [
    'staticBlankTwice',
    false,
    'public class Main { static final int F; static { F = 1; } static { F = 2; } public static void main(String[] a) { } }',
  ],
  [
    'finalCatchParam',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    try { System.out.println(1); } catch (final RuntimeException e) { e = new RuntimeException(); }\n  }\n  \n}\n',
  ],
  [
    'objectFinalReassign',
    false,
    'public class Main { final Object f = new Object(); void set() { this.f = new Object(); } public static void main(String[] a) { } }',
  ],
  [
    'multiCatchRelated',
    false,
    'class E1 extends Exception {}\nclass E2 extends E1 {}\npublic class Main { public static void main(String[] args) { try { throw new E2(); } catch (E1 | E2 e) { } } }\n',
  ],
  [
    'multiCatchUnrelated',
    true,
    'class E1 extends Exception {}\nclass E2 extends E1 {}\npublic class Main { public static void main(String[] args) { try { throw new E2(); } catch (E2 | RuntimeException e) { } catch (E1 e) { } } }\n',
  ],
  [
    'siblingInit',
    true,
    'public class Main { final int a; final int b = (a = 1); public static void main(String[] x) { System.out.println(new Main().a); } }',
  ],
  [
    'siblingStaticInit',
    true,
    'public class Main { static final int A; static final int B = (A = 1); public static void main(String[] x) { } }',
  ],
  [
    'siblingArrayInit',
    true,
    'public class Main { final int a; final int[] b = new int[] { (a = 1) }; public static void main(String[] x) { } }',
  ],
  [
    'fieldInitReadsBlank',
    false,
    'public class Main { final int a; int b = a; Main() { a = 1; } public static void main(String[] x) { } }',
  ],
  [
    'thisConstLoop',
    true,
    'public class Main { final boolean b = true; void m() { while (this.b) { } System.out.println(1); } public static void main(String[] a) { } }',
  ],
  [
    'thisConstMissingReturn',
    false,
    'public class Main { final boolean b = true; int f() { while (this.b) { } } public static void main(String[] a) { } }',
  ],
  [
    'thisConstDa',
    false,
    'public class Main { final boolean b = true; void m() { int x; if (this.b) x = 1; System.out.println(x); } public static void main(String[] a) { } }',
  ],
  [
    'simpleConstLoop',
    false,
    'public class Main { final boolean b = true; void m() { while (b) { } System.out.println(1); } public static void main(String[] a) { } }',
  ],
  [
    'typeNameConstLoop',
    false,
    'public class Main { static final boolean B = true; void m() { while (Main.B) { } System.out.println(1); } public static void main(String[] a) { } }',
  ],
  [
    'returnThroughFinally',
    true,
    'public class Main { final int f; Main() { try { return; } finally { f = 1; } } public static void main(String[] a) { } }',
  ],
  [
    'returnInCatchFinally',
    true,
    'public class Main { final int f; Main() { try { throw new RuntimeException(); } catch (RuntimeException e) { return; } finally { f = 1; } } public static void main(String[] a) { } }',
  ],
  [
    'thisTryFinallyTwice',
    false,
    'public class Main { final int x; Main() { try { this.x = 1; } finally { this.x = 2; } } public static void main(String[] a) { new Main(); } }',
  ],
  [
    'thisTryCatchTwice',
    false,
    'public class Main { final int n; Main(String s) { try { this.n = Integer.parseInt(s); } catch (NumberFormatException e) { this.n = 0; } } public static void main(String[] a) { System.out.println(new Main("x").n); } }',
  ],
  [
    'shadowedThisTry',
    true,
    'public class Main { final int x; Main(int x) { try { this.x = x; } finally { } } public static void main(String[] a) { new Main(1); } }',
  ],
  [
    'finallyReturnSuppresses',
    true,
    'public class Main { static void f() throws Exception {} public static void main(String[] a) { try { f(); } finally { return; } } }',
  ],
  [
    'finallyThrowSuppresses',
    true,
    'public class Main { static void f() throws Exception {} public static void main(String[] a) { try { f(); } catch (RuntimeException e) { throw new Exception(); } finally { throw new RuntimeException(); } } }',
  ],
  [
    'finallyNormalPropagates',
    false,
    'public class Main { static void f() throws Exception {} public static void main(String[] a) { try { f(); } finally { System.out.println(1); } } }',
  ],
  [
    'npeNullMessage',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    NullPointerException e = new NullPointerException(null); System.out.println(e.getMessage());\n  }\n  \n}\n',
  ],
  [
    'npeCause',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    NullPointerException e = new NullPointerException(new RuntimeException());\n  }\n  \n}\n',
  ],
  [
    'iaeCause',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    IllegalArgumentException e = new IllegalArgumentException("x", new RuntimeException());\n  }\n  \n}\n',
  ],
  [
    'andConstLoop',
    true,
    'public class Main { static int f() { while (true && true) {} } public static void main(String[] args) {} }',
  ],
  [
    'orConstFinal',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final boolean go = false || true; int n; if (go) n = 1; System.out.println(n);\n  }\n  \n}\n',
  ],
  [
    'andNonConst',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int n; if (args.length > 0 && true) n = 1; System.out.println(n);\n  }\n  \n}\n',
  ],
  [
    'shadowLocalInTry',
    true,
    'public class Main { final int x; Main() { try { int x = 1; x = 2; } finally { this.x = 3; } } public static void main(String[] args) { new Main(); } }',
  ],
  [
    'conditionalConstLoop',
    true,
    'public class Main { static int f() { while (true ? true : false) {} } public static void main(String[] args) {} }',
  ],
  [
    'conditionalConstFinal',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final boolean go = 1 < 2 ? true : false; int n; if (go) n = 1; System.out.println(n);\n  }\n  \n}\n',
  ],
  [
    'conditionalNonConst',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int n; if (args.length > 0 ? true : false) n = 1; System.out.println(n);\n  }\n  \n}\n',
  ],
  [
    'conditionalConstSwitch',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    final int k = true ? 1 : 2; switch (args.length) { case k: break; default: break; }\n  }\n  \n}\n',
  ],
  [
    'doubleSemicolonReturn',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    return;;\n  }\n  \n}\n',
  ],
  [
    'doubleSemicolonThrow',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    throw new RuntimeException();;\n  }\n  \n}\n',
  ],
  [
    'emptyAfterLoop',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    while (true) {};\n  }\n  \n}\n',
  ],
  [
    'doubleSemicolonOk',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x = 1;; System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'ifDoubleSemicolon',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    if (args.length > 0) return;;\n  }\n  \n}\n',
  ],
  [
    'switchEmpty',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    switch (args.length) { case 0: break;; default: }\n  }\n  \n}\n',
  ],
  [
    'afterBreak',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    while (true) { break; System.out.println(1); }\n  }\n  \n}\n',
  ],
  [
    'afterContinue',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    for (int i = 0; i < 2; i++) { continue; System.out.println(1); }\n  }\n  \n}\n',
  ],
  [
    'ifBreakOk',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    while (true) { if (args.length == 0) break; System.out.println(1); }\n  }\n  \n}\n',
  ],
  [
    'labeledBlockBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    a: { break a; } System.out.println(1);\n  }\n  \n}\n',
  ],
  [
    'doContinue',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; do { i++; continue; } while (i < 3); System.out.println(i);\n  }\n  \n}\n',
  ],
  [
    'doContinueMissingReturn',
    false,
    'public class Main { static int f() { int i = 0; do { i++; continue; } while (i < 3); } public static void main(String[] a) { } }',
  ],
  [
    'doContinueTry',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; do { try { i++; continue; } finally { } } while (i < 3); System.out.println(i);\n  }\n  \n}\n',
  ],
  [
    'doContinueTrue',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; do { i++; continue; } while (true); System.out.println(i);\n  }\n  \n}\n',
  ],
  [
    'doLabeledContinue',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; outer: do { for (;;) { i++; continue outer; } } while (i < 3); System.out.println(i);\n  }\n  \n}\n',
  ],
  [
    'doSwitchContinue',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; do { switch (i) { default: i++; continue; } } while (i < 3); System.out.println(i);\n  }\n  \n}\n',
  ],
  [
    'continueAbruptFinally',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    do { try { continue; } finally { throw new RuntimeException(); } } while (false); System.out.println(1);\n  }\n  \n}\n',
  ],
  [
    'breakAbruptFinally',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    while (true) { try { break; } finally { throw new RuntimeException(); } } System.out.println(1);\n  }\n  \n}\n',
  ],
  [
    'breakNormalFinally',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    while (true) { try { break; } finally { System.out.println(0); } } System.out.println(1);\n  }\n  \n}\n',
  ],
  [
    'multiLabelDoContinue',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; outer: inner: do { i++; continue outer; } while (i < 2); System.out.println(i);\n  }\n  \n}\n',
  ],
  [
    'multiLabelBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; outer: inner: { x = 1; break outer; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'multiLabelWhileTrueBreak',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int x; outer: inner: while (true) { x = 1; break outer; } System.out.println(x);\n  }\n  \n}\n',
  ],
  [
    'labeledBlockContinue',
    false,
    'public class Main {\n  public static void main(String[] args) {\n    while (true) { a: { continue a; } }\n  }\n  \n}\n',
  ],
  [
    'innerLabelContinue',
    true,
    'public class Main {\n  public static void main(String[] args) {\n    int i = 0; outer: inner: do { i++; continue inner; } while (i < 2); System.out.println(i);\n  }\n  \n}\n',
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
    expect(row).toBeGreaterThanOrEqual(0);
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

test('a missing semicolon after a declaration is reported on its line', () => {
  const source = 'class Main {\n  public static void main(String[] args) {\n    int count = 1\n  }\n}';
  expect(executeJavaProgram(source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: '「;」が足りません。' }],
  });
});

test.each([
  [
    'a returned value',
    'class Main {\n  static int f() {\n    return true;\n  }\n  public static void main(String[] a) { }\n}',
  ],
  ['an array element', 'class Main {\n  public static void main(String[] a) {\n    int[] xs = {1, true};\n  }\n}'],
])('a type error in %s is reported on its line', (_, source) => {
  expect(executeJavaProgram(source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: 'boolean 型の値を int 型に変換できません。' }],
  });
});

test.each([
  ['long x = 0;', '型「long」は、この採点環境では使えません。'],
  ['double r = Math.round(2.5);', 'この採点環境の Math には、メソッド round がありません。'],
  ['StringBuilder b = null;', 'この採点環境には、型 StringBuilder がありません。'],
  [
    'String s = String.valueOf(1, 2);',
    'この採点環境では、メソッド valueOf に (int, int) を渡して呼び出すことはできません。',
  ],
  ['int n = Integer.parseInt(123);', 'この採点環境では、メソッド parseInt に (int) を渡して呼び出すことはできません。'],
  [
    'Object e = new IndexOutOfBoundsException(1);',
    'この採点環境では、コンストラクタ IndexOutOfBoundsException に (int) を渡して呼び出すことはできません。',
  ],
  ['Object o = new Object(); o.getClass();', 'この採点環境の Object には、メソッド getClass がありません。'],
  [
    'Turtle t = new Turtle(); t.前に進む(3);',
    'この採点環境では、メソッド 前に進む に (int) を渡して呼び出すことはできません。',
  ],
  ['Turtle t = new Turtle(); t.x = 3;', 'この採点環境の Turtle には、フィールド x がありません。'],
  ['Turtle t = new Turtle(); t.前進する();', 'この採点環境の Turtle には、メソッド 前進する がありません。'],
])('messages about what Java may have state only what this environment has: %s', (body, message) => {
  const source = `class Main {\n  public static void main(String[] args) {\n    ${body}\n  }\n}`;
  expect(executeJavaProgram(source)).toEqual({ kind: 'compileError', diagnostics: [{ row: 2, message }] });
});

test('exceptions keep their causes and Math offers its constants', () => {
  const source = `class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    RuntimeException e = new RuntimeException(new IllegalStateException("x"));
    if (e.getCause() instanceof IllegalStateException && e.getMessage().equals("java.lang.IllegalStateException: x")) t.前に進む();
    if (Math.PI > 3.14 && Math.E > 2.71) t.前に進む();
  }
}`;
  expect(executeJavaProgram(source)).toMatchObject({
    kind: 'executed',
    finalTurtles: [{ x: 0, y: 2, color: '#', dir: 'N' }],
    uncaughtException: undefined,
  });
});

test('a missing field through super names the superclass', () => {
  const source =
    'class A {}\nclass Main extends A {\n  void f() { super.missing = 1; }\n  public static void main(String[] a) {}\n}';
  expect(executeJavaProgram(source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: 'この採点環境の A には、フィールド missing がありません。' }],
  });
});
