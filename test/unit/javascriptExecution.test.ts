import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('a program that draws reports its final board and the turtles still reachable', () => {
  const execution = executeProgram(
    'javascript',
    `const keep = new Turtle(1, 1, 'G');
function draw() {
  const temporary = new Turtle(4, 4, 'Y');
  temporary.forward();
}
draw();
keep.turnRight();
keep.forward();`
  );
  expect(execution).toEqual({
    kind: 'executed',
    finalBoard: ['.......', '.GG....', '.......', '.......', '....Y..', '....Y..', '.......'].join('\n'),
    finalTurtles: [{ x: 2, y: 1, color: 'G', dir: 'E' }],
    uncaughtException: undefined,
  });
});

test.each([
  ['a duplicate declaration', 'let a = 1;\nlet a = 2;', 1, 'a はすでに宣言されています。'],
  ['a var that redeclares a let', 'let a = 1;\n{ var a = 2; }', 1, 'a はすでに宣言されています。'],
  ['a const without a value', 'const a;', 0, 'const で宣言する変数には初期値が必要です。'],
  ['break outside a loop', 'if (true) {\n  break;\n}', 1, 'break 文はループや switch 文の中にしか書けません。'],
  ['continue to a label of a block', 'block: {\n  continue block;\n}', 1, 'ラベル block はループに付いていません。'],
  ['return outside a function', 'return 1;', 0, 'return 文は関数の中にしか書けません。'],
  [
    'super() outside a derived constructor',
    'class A {\n  constructor() { super(); }\n}',
    1,
    'super(...) は継承したクラスのコンストラクタの中にしか書けません。',
  ],
  ['a declaration as the body of if', 'if (true) let a = 1;', 0, '宣言を書くには { } で囲んでください。'],
  ['an async function', 'async function f() {}', 0, 'async 関数は、この採点環境では使えません。'],
  ['a generator', 'function* f() {}', 0, 'ジェネレータ関数は、この採点環境では使えません。'],
  ['a regular expression', 'const r = /a/;', 0, '正規表現は、この採点環境では使えません。'],
  ['a BigInt', 'const n = 1n;', 0, '数値「1n」は、この採点環境では使えません。'],
  ['import', "import x from 'x';", 0, 'import や export は、この採点環境では使えません。'],
  ['a syntax error', 'const t = new Turtle(;', 0, '「)」が足りません。'],
])('%s is a compile error', (_, source, row, message) => {
  expect(executeProgram('javascript', source)).toEqual({ kind: 'compileError', diagnostics: [{ row, message }] });
});

test.each([
  [
    'reading before initialization',
    'console.log(a);\nlet a = 1;',
    "ReferenceError: Cannot access 'a' before initialization",
  ],
  ['an undeclared variable', 'missing = 1;', 'ReferenceError: missing is not defined'],
  ['assigning a constant', 'const a = 1;\na = 2;', 'TypeError: Assignment to constant variable.'],
  ['calling a misspelled method', 'const t = new Turtle();\nt.foward();', 'TypeError: t.foward is not a function'],
  ['reading a property of undefined', 'let o;\no.x;', "TypeError: Cannot read properties of undefined (reading 'x')"],
  ['calling a class without new', 'class A {}\nA();', "TypeError: Class constructor A cannot be invoked without 'new'"],
  ['a turtle at an invalid position', 'new Turtle(1.5, 0);', 'TypeError: Invalid position: (1.5, 0)'],
  ['a turtle with an invalid color', "new Turtle(0, 0, 'Z');", 'Error: Invalid color: Z'],
  ['a turtle leaving the board', 'const t = new Turtle(0, 6);\nt.forward();', 'Error: Out of bounds: (0, 7)'],
  ['a thrown value', "throw 'stop';", 'stop'],
  ['a custom error', "class Oops extends Error {}\nthrow new Oops('bad');", 'Error: bad'],
  ['infinite recursion', 'function f() { return f(); }\nf();', 'RangeError: Maximum call stack size exceeded'],
  [
    'a turtle method called on another object',
    'const forward = new Turtle().forward;\nforward.call({});',
    'TypeError: Turtle.prototype.forward requires a turtle',
  ],
])('%s ends the program with an uncaught exception', (_, source, description) => {
  expect(executeProgram('javascript', source)).toMatchObject({ kind: 'executed', uncaughtException: description });
});

test('a caught exception lets the program continue', () => {
  expect(
    executeProgram(
      'javascript',
      `const t = new Turtle(0, 6);
try {
  t.forward();
} catch (error) {
  t.backward();
} finally {
  t.turnRight();
}`
    )
  ).toMatchObject({ kind: 'executed', finalTurtles: [{ x: 0, y: 6, dir: 'E' }], uncaughtException: undefined });
});

test.each([
  ['an infinite loop', 'while (true) {}', { kind: 'limitExceeded', limit: 'operations' }],
  ['an infinite loop of empty statements', 'for (;;);', { kind: 'limitExceeded', limit: 'operations' }],
  ['endless output', "for (;;) console.log('x'.repeat(1000));", { kind: 'limitExceeded', limit: 'output' }],
  [
    'a huge array',
    'const a = new Array(2 ** 31);',
    { kind: 'executed', uncaughtException: 'RangeError: Out of memory' },
  ],
  [
    'growing an array by its length',
    'const a = [];\na.length = 4e9;',
    { kind: 'executed', uncaughtException: 'RangeError: Out of memory' },
  ],
  [
    'a huge string',
    "let s = 'x';\nwhile (true) s += s;",
    { kind: 'executed', uncaughtException: 'RangeError: Invalid string length' },
  ],
  [
    'a repeated huge string',
    "'x'.repeat(2 ** 28);",
    { kind: 'executed', uncaughtException: 'RangeError: Invalid string length' },
  ],
  ['many objects', 'const a = [];\nwhile (true) a.push({ x: 1 });', { kind: 'limitExceeded' }],
  [
    'garbage collections over a large array',
    'const t = new Turtle();\nconst a = new Array(900000).fill(0);\nwhile (true) t.canMoveForward();',
    { kind: 'limitExceeded' },
  ],
  [
    'sorting with a slow comparison',
    'const a = new Array(100000).fill(0).map((_, i) => -i);\na.sort((x, y) => x - y);\nwhile (true) {}',
    { kind: 'limitExceeded' },
  ],
  ['deeply nested blocks', `${'{'.repeat(9000)}${'}'.repeat(9000)}`, { kind: 'compileError' }],
  ['deeply nested negations', `const b = ${'!'.repeat(19_000)}true;`, { kind: 'compileError' }],
  [
    'a deeply nested call stack',
    'function f(n) { if (n > 0) { { { { { { f(n - 1); } } } } } } }\nf(100000);',
    { kind: 'executed' },
  ],
])('%s ends within the limits', (_, source, expected) => {
  const startedAt = performance.now();
  expect(executeProgram('javascript', source)).toMatchObject(expected);
  expect(performance.now() - startedAt).toBeLessThan(5000);
});
