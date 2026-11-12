import { execFileSync } from 'node:child_process';

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
    stdout: '',
    stderr: '',
    finalFiles: {},
  });
});

test.each([
  ['a duplicate declaration', 'let a = 1;\nlet a = 2;', 1, 'a はすでに宣言されています。'],
  ['a let that redeclares a var in its block', '{\n  var a = 1;\n  let a = 2;\n}', 2, 'a はすでに宣言されています。'],
  ['a var that redeclares a let', 'let a = 1;\n{ var a = 2; }', 1, 'a はすでに宣言されています。'],
  [
    'a static method named prototype',
    'class A {\n  static prototype() {}\n}',
    1,
    'static メンバーに prototype という名前は使えません。',
  ],
  [
    'a field named constructor',
    'class A {\n  constructor = 1;\n}',
    1,
    'フィールドに constructor という名前は使えません。',
  ],
  ['a const without a value', 'const a;', 0, 'const で宣言する変数には初期値が必要です。'],
  ['break outside a loop', 'if (true) {\n  break;\n}', 1, 'break 文はループや switch 文の中にしか書けません。'],
  [
    'an unlabeled break in a labeled block',
    'block: {\n  break;\n}',
    1,
    'break 文はループや switch 文の中にしか書けません。',
  ],
  ['continue to a label of a block', 'block: {\n  continue block;\n}', 1, 'ラベル block はループに付いていません。'],
  ['return outside a function', 'return 1;', 0, 'return 文は関数の中にしか書けません。'],
  [
    'super() outside a derived constructor',
    'class A {\n  constructor() { super(); }\n}',
    1,
    'super(...) は継承したクラスのコンストラクタの中にしか書けません。',
  ],
  ['a declaration as the body of if', 'if (true) let a = 1;', 0, '宣言を書くには { } で囲んでください。'],
  [
    'a yield in a destructuring default',
    'function* f() {\n  const [a = yield] = [];\n}',
    1,
    '分割代入の初期値の yield や await は、この採点環境では使えません。',
  ],
  ['an invalid regular expression', 'const r = /(/;', 0, '正規表現の書き方に誤りがあります。'],
  ['invalid regular expression flags', 'const r = /a/gg;', 0, '正規表現の書き方に誤りがあります。'],
  [
    'arguments in a static block',
    'class A {\n  static { arguments; }\n}',
    1,
    'フィールドの初期値や static ブロックの中では arguments を使えません。',
  ],
  ['new.target outside functions', 'console.log(new.target);', 0, 'new.target は関数の中にしか書けません。'],
  ['a legacy octal number', 'const n = 017;', 0, '数値「017」は、この採点環境では使えません。'],
  ['import', "import x from 'x';", 0, 'import や export は、この採点環境では使えません。'],
  ['a syntax error', 'const t = new Turtle(;', 0, '「)」が足りません。'],
  ['try without catch or finally', 'try {\n  console.log(1);\n}', 0, '書き方に誤りがあります。'],
  ['a stray comma in arguments', 'function f(a, b) {}\nf(1,, 2);', 1, '書き方に誤りがあります。'],
  ['a stray comma in an object literal', 'const o = { a: 1,, b: 2 };', 0, '書き方に誤りがあります。'],
  ['a stray comma in an object pattern', 'const { a,, b } = { a: 1, b: 2 };', 0, '書き方に誤りがあります。'],
  ['a function statement without a name', 'function () {}', 0, '書き方に誤りがあります。'],
  ['a class statement without a name', 'class {}', 0, '書き方に誤りがあります。'],
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
  ['constructing a generator', 'function* f() {}\nnew f();', 'TypeError: f is not a constructor'],
  [
    'a rejected promise without a handler',
    "async function f() {\n  await null;\n  throw new Error('boom');\n}\nf();",
    'Error: boom',
  ],
  ['an exception in a timer', "setTimeout(() => {\n  throw new Error('late');\n}, 0);", 'Error: late'],
  [
    'resuming a running generator',
    'const g = (function* () { g.next(); yield 1; })();\ng.next();',
    'TypeError: Generator is already running',
  ],
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
    'concatenating an array with itself many times',
    'const a = new Array(100000).fill(0);\na.concat(...new Array(100000).fill(a));',
    { kind: 'executed', uncaughtException: 'RangeError: Out of memory' },
  ],
  [
    'flatMap to a large array',
    'const a = new Array(10000).fill(0);\na.flatMap(() => a);',
    { kind: 'limitExceeded', limit: 'operations' },
  ],
  [
    'joining holes with a long separator',
    "new Array(100000).join('x'.repeat(100000));",
    { kind: 'executed', uncaughtException: 'RangeError: Invalid string length' },
  ],
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
  [
    'concatenating a long string many times',
    "''.concat(...new Array(1000).fill('x'.repeat(1000000)));",
    { kind: 'executed', uncaughtException: 'RangeError: Invalid string length' },
  ],
  [
    'logging a long string many times',
    "console.log(new Array(1000).fill('x'.repeat(100000)));",
    { kind: 'limitExceeded', limit: 'output' },
  ],
  [
    'logging a nested long string once',
    "console.log(['x'.repeat(60000)]);\nconsole.log('done');",
    { kind: 'executed', uncaughtException: undefined },
  ],
  [
    'replacing with a long string',
    "'a'.repeat(600000).replace('a', 'b'.repeat(600000));",
    { kind: 'executed', uncaughtException: 'RangeError: Invalid string length' },
  ],
  [
    'scanning a large sparse array many times',
    'const a = new Array(900000);\nfor (let i = 0; i < 100; i++) a.some(() => false);',
    { kind: 'limitExceeded' },
  ],
  [
    'filling an empty range backward many times',
    'const a = new Array(100000);\nfor (let i = 0; i < 1000000; i++) a.fill(0, 100000, 0);',
    { kind: 'limitExceeded' },
  ],
  [
    'Array.from(null)',
    'Array.from(null);',
    { kind: 'executed', uncaughtException: 'TypeError: Cannot convert undefined or null to object' },
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

test.each([
  ["'ab'.replaceAll('', '-')", '-a-b-'],
  ['String(new (class { constructor() { return 1; } })() instanceof Object)', 'true'],
  [
    '(() => { const a = [1, 2, 3]; delete a[0]; let n = 0; a.forEach(() => n++); return String([n, a.length, 0 in a]); })()',
    '2,3,false',
  ],
  ['String(new Array(3).map((_, i) => i).length + Object.keys([1, , 3]).length)', '5'],
  ['String(new Array(5000).fill(7).join().length)', '9999'],
  [
    '(() => { const holes = [1, , 2]; function f(a,) { return a; } const { a, } = { a: 1 }; const o = { b: 2, }; return String([holes.length, f(1,), a, o.b]); })()',
    '3,1,1,2',
  ],
  [
    'String((() => { function sum() { const all = () => arguments.length; return [arguments[0] + arguments[1], all()]; } return sum(1, 2); })())',
    '3,2',
  ],
  ['String((() => { function pack() { return { arguments }; } return pack(1, 2).arguments[1]; })())', '2'],
  [
    'String((() => { class Path extends Array { count() { return this.length; } } const a = new Path(2); return [a.count(), a instanceof Path, Array.isArray(a)]; })())',
    '2,true,true',
  ],
  ['String(Array.from([1, 2], function (v) { return v * this.step; }, { step: 2 }))', '2,4'],
  [
    'String((() => { class A { set x(v) { this.stored = v; } } class B extends A { set x(v) { super.x = v + 1; } } const b = new B(); b.x = 2; return b.stored; })())',
    '3',
  ],
  [
    '(() => { let x = [1, 2]; try { for (let x of x) {} return "ran"; } catch (e) { return e.name; } })()',
    'ReferenceError',
  ],
  [
    'String((() => { Array.prototype[0] = 7; const a = new Array(1); const values = [a.join(), a.some((x) => x === 7), [...a][0]]; delete Array.prototype[0]; return values; })())',
    '7,true,7',
  ],
  [
    'String((() => { const a = [1, 2, 3]; let calls = 0; a.some(() => { calls++; a.length = 0; return false; }); return calls; })())',
    '1',
  ],
  ['String((() => { const a = [3, 1, 2]; a.sort((x, y) => { a.length = 0; return x - y; }); return a; })())', '1,2,3'],
  ['String((() => { const a = [{ toString() { a.push(2); return "1"; } }]; return a.join(); })())', '1'],
  ['String((() => { const { 1: skip, ...rest } = "abc"; return [rest[0], rest[2], rest[1]]; })())', 'a,c,'],
  [
    'String((() => { const o = { v: 1, get() { return this?.v; } }; const x = null; let threw = false; try { (x?.get)(); } catch { threw = true; } return [((o.get))(), (o.get)(), threw, (x?.foo.bar)?.()]; })())',
    '1,1,true,',
  ],
  [
    'String((() => { const item = null; const box = { cached: 1 }; return [delete item?.cached, delete (item?.nested.cached), delete box?.cached, "cached" in box]; })())',
    'true,true,true,false',
  ],
  ['String((() => { const a = []; const [x = (a.push(8, 9), 1), y] = a; return [x, y === undefined]; })())', '1,true'],
  ["String(['B', 'a', 'C', 'é', 'e', 'z'].sort((a, b) => a.localeCompare(b)))", 'a,B,C,e,é,z'],
  [
    '(() => { const results = []; for (const change of [() => Object.freeze([]).reverse(), () => Object.freeze([1]).reverse(), () => Object.freeze([1]).fill(0, 1), () => Object.freeze([, ]).sort(), () => { delete Object.freeze([, ])[0]; }, () => Object.freeze([, , ]).reverse(), () => Object.freeze([, 1, , ]).reverse(), () => Object.freeze([1, 2]).reverse(), () => Object.freeze([]).push()]) { try { change(); results.push("ok"); } catch (e) { results.push(e.name); } } return String(results); })()',
    'ok,ok,ok,ok,ok,ok,ok,TypeError,TypeError',
  ],
  ['String((() => { const a = [undefined, 2]; const [x = (a[1] = 9), y] = a; return [x, y]; })())', '9,9'],
  [
    'String((() => { class A {} class B extends A { constructor() { const same = super() === this; this.same = same; } } return new B().same; })())',
    'true',
  ],
  [
    'String((() => { const a = [1, 2]; return Array.from(a, (x, i) => { if (i === 0) a[1] = 9; return x; }); })())',
    '1,9',
  ],
  [
    '(() => { const a = Object.freeze([1]); const errors = []; for (const change of [() => { a[0] = 2; }, () => a.push(2), () => { a.length = 0; }, () => delete a[0]]) { try { change(); } catch (e) { errors.push(e.name); } } return String([errors, a]); })()',
    'TypeError,TypeError,TypeError,TypeError,1',
  ],
  [
    '(() => { const a = [1, , 3]; const out = []; for (const x of a) { out.push(x); if (out.length === 1) a[2] = 4; } return String(out); })()',
    '1,,4',
  ],
  [
    'String((() => { const a = [1, , 3]; return a.reduce((s, v, i) => { if (i === 0) a[1] = 2; return s + v; }, 0); })())',
    '6',
  ],
  ["String('a'.repeat(8000).replaceAll('a', 'b').length)", '8000'],
  [
    '(() => { let b = 4; function f(a = b, b = 2) { return a; } try { f(); return "no error"; } catch (e) { return e.name; } })()',
    'ReferenceError',
  ],
  ['String((() => { const xs = [1, 2]; return xs.find((x, i) => { xs[i] = 9; return true; }); })())', '1'],
  [
    'String((() => { class A { #x = 1; get() { return this.#x; } } class B extends A { #x = 2; }; return new B().get(); })())',
    '1',
  ],
])('%s evaluates as JavaScript does', (expression, expected) => {
  const execution = executeProgram(
    'javascript',
    `const result = ${expression};\nif (result !== '${expected}') throw result;`
  );
  expect(execution).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['grouped arrays', "console.log([1, 22, 333, 4444, 5, 6, 7], ['a', 'bb', 'ccc', 'dddd', 'e', 'f', 'g', 'h']);"],
  ['long arrays', 'console.log(Array.from({ length: 150 }, (_, i) => i * i), [1, , , 4]);'],
  [
    'objects that do not fit on a line',
    "console.log({ name: 'Taro Yamada', age: 20, hobbies: ['reading', 'swimming'], address: { city: 'Tokyo', zip: '100-0001' } });",
  ],
  ['nested objects beyond the depth limit', 'console.log({ a: { b: { c: { d: 1 }, e: [] } } }, [[[[1]]]]);'],
  [
    'class instances and functions',
    'class A { x = 1; } class B extends A {} console.log(new B(), B, Object.create(null), () => 1);',
  ],
  ['quoted strings and keys', String.raw`console.log(["it's", 'say "hi"\n', '\x01'], { 'a-b': 1, 2: 'two', $c: 3 });`],
  ['circular references', 'const a = { b: {} }; a.b.a = a; a.self = a; console.log(a);'],
  ['format specifiers', "console.log('%s is %d%% %j', 'x', 50, { a: [1] }, 'rest', { b: 2 });"],
])('console.log prints %s as Node.js does', (_, source) => {
  expect(executeProgram('javascript', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: runOnNode(source),
  });
});

test.each([
  [
    'regular expressions',
    `const re = /(\\w)(\\d)?/g;
let m;
while ((m = re.exec('a1b c3')) !== null) console.log(m[0], m[1], m[2], m.index, re.lastIndex);
console.log('x-y_z'.replace(/[-_](\\w)/g, (_, c, off, s) => c.toUpperCase() + off + s.length));
console.log('John Smith'.replace(/(?<first>\\w+)\\s(?<last>\\w+)/, '$<last>, $<first> $$ $&'));
console.log('aaa'.replace(/a/gy, 'b'), 'baaa'.replace(/a/y, 'b'));
console.log('a,b;c d'.split(/[,; ]/), 'a1b2c3'.split(/(\\d)/), 'abc'.split(/(?:)/u, 2));
console.log('Hello'.match(/l/g), 'Hello'.match(/z/), 'Hello'.match(/z/g), 'x'.search(/y/));
const sticky = /foo/y; sticky.lastIndex = 3; console.log(sticky.test('barfoo'), sticky.lastIndex, sticky.test('barfoo'), sticky.lastIndex);
console.log(/a/.source, /\\//.source, new RegExp('').source, new RegExp('a/b').toString(), RegExp(/x/g, 'i').flags);
console.log(/a/gimsuyd.flags, /x/.global, /x/g.global, typeof /x/, /x/ instanceof RegExp);
try { new RegExp('('); } catch (e) { console.log(e.name); }
try { 'a'.matchAll(/a/); } catch (e) { console.log(e.message); }
try { 'a'.replaceAll(/a/, 'b'); } catch (e) { console.log(e.message); }
console.log([...'a1b2'.matchAll(/\\d/g)].map((x) => x[0] + x.index));
const r2 = /b/g; r2.lastIndex = 2; console.log([...'abab'.matchAll(r2)].length, r2.lastIndex);
console.log('2020-01-02'.replace(/(\\d+)-(\\d+)-(\\d+)/, '$3/$2/$1'), 'abc'.replace(/(?<x>b)/, (...a) => typeof a.at(-1)));
console.log('CamelCaseString'.split(/(?=[A-Z])/).join(' '), /^\\d{3}-\\d{4}$/.test('123-4567'), 'ab'.match(/(?<n>a)|(?<m>z)/).groups.m);
const d = /(?<w>b)/d.exec('abc'); console.log(d.indices[0], d.indices.groups.w);
console.log(String(/a/g), \`\${/b/}\`, /a/ + '', /[/]/.source);
{
const m = /(?<y>\\d{4})-(?<m>\\d\\d)/.exec('on 2024-03!');
console.log(m.index, m[0], m.groups.y, m.groups.m);
console.log('abc'.replace(/b/, (s) => s.toUpperCase()));
console.log('a-b-c'.replaceAll('-', '+'));
console.log('xyz'.search(/z/));
for (const x of 'a1b2'.matchAll(/[a-z](\\d)/g)) console.log(x[1], x.index);
console.log(new RegExp('h.l', 'i').test('HAL'));
}`,
  ],
  [
    'tagged templates',
    `function tag(s, ...v) { return [s, s.raw, v, (() => { try { s.push(1); } catch (e) { return e.constructor.name; } })(), 0, s.length]; }
console.log(tag\`a\\n\${1}\\u{41}\${'x'}\\unicode\`);
const same = () => ((s) => s)\`x\`;
console.log(same() === same());
const o = { name: 'o', t(s, x) { return this.name + s[0] + x; } };
console.log(o.t\`[\${5}]\`, o['t']\`<\${6}>\`);
console.log(String.raw\`C:\\new\\table\${1 + 1}\\x\`, String.raw({ raw: ['a', 'b', 'c'] }, 1, 2, 3, 4));
console.log(\`plain \${[1, 2]}\`);
const nested = (s, ...v) => s.join('_') + v.join('+');
console.log(nested\`a\${nested\`b\${1}\`}c\`);`,
  ],
  [
    'static blocks, new.target, and #name in',
    `class Base { static greet() { return 'hi'; } }
class A extends Base {
  static a = 1;
  static { var v = this.a + 1; this.b = v; console.log(super.greet(), this === A); }
  static c = A.b * 10;
  static #p = 5;
  static { const f = () => this.#p; console.log(f(), new.target); }
}
console.log(A.a, A.b, A.c);
class B { #v = 3; static isB(o) { return #v in o; } static { console.log(B.isB(new B()), B.isB([])); } }
try { class C { #q; static t(o) { return #q in o; } } C.t(1); } catch (e) { console.log(e.message); }
function G() { if (!new.target) return new G(); this.ok = true; }
console.log(G().ok);
const arrow = function () { return (() => new.target)(); };
console.log(new arrow() instanceof Object, arrow());
debugger;`,
  ],
  [
    'generators',
    `function* fib() { let [a, b] = [0, 1]; for (;;) { yield a; [a, b] = [b, a + b]; } }
const out = []; for (const v of fib()) { if (v > 50) break; out.push(v); } console.log(out.join(' '));
function* take(it, n) { let i = 0; for (const v of it) { if (i++ >= n) return; yield v; } }
console.log([...take(fib(), 5)]);
const obj = { *items() { yield* [1, 2]; yield* 'ab'; const r = yield* (function* () { yield 'x'; return 'ret'; })(); yield r; } };
console.log([...obj.items()]);
class Tree { constructor(v, l, r) { this.v = v; this.l = l; this.r = r; } *walk() { if (this.l) yield* this.l.walk(); yield this.v; if (this.r) yield* this.r.walk(); } }
console.log([...new Tree(2, new Tree(1), new Tree(3)).walk()]);
function* g() { try { const x = yield 1; console.log('got', x); yield x * 2; } catch (e) { console.log('caught', e); yield 'after'; } finally { console.log('fin'); } }
let it = g(); console.log(it.next('ignored'), it.next(21), it.throw('boom'), it.next(), it.next());
it = g(); it.next(); console.log(it.return(7), it.next());
it = g(); console.log(it.return(8), it.next());
function* h() { try { yield 1; } finally { yield 'cleanup'; } }
it = h(); it.next(); console.log(it.return(3), it.next(), it.next());
try { it = g(); it.throw(new Error('early')); } catch (e) { console.log(e.message); }
const gen = function* (a, b = a + 1) { yield a + b; yield arguments.length; }; console.log([...gen(1)]);
console.log(typeof gen().next, Object.prototype.toString.call(gen()), gen().constructor === undefined);
function* nested() { const a = (yield 'q1') + (yield 'q2'); return a; }
it = nested(); console.log(it.next().value, it.next(10).value, it.next(5));
function* cond(x) { const v = x ? yield 'yes' : yield 'no'; console.log(\`v=\${v}\`); yield [yield 'arr', 0]; }
console.log([...cond(true)]);
const ys = function* () { let i = 0; while (i < 3) { const cmd = yield i++; if (cmd) i = 0; } }();
console.log(ys.next().value, ys.next().value, ys.next(true).value, ys.next().value);
function* deleg() { try { yield* inner(); } finally { console.log('outer fin'); } } function* inner() { try { yield 1; yield 2; } finally { console.log('inner fin'); } }
for (const v of deleg()) { console.log(v); break; }
const d = deleg(); d.next(); console.log(d.return(9));
console.log(Array.from(take(fib(), 3)), Math.max(...take(fib(), 6)));
const [p, q] = fib(); console.log(p, q);
{
function* counter() { let x = 0; while (true) { const cmd = yield x; if (cmd === 'reset') x = 0; else x++; } }
const c = counter();
console.log(c.next().value, c.next().value, c.next().value, c.next('reset').value, c.next().value);
function* t() { try { yield 1; yield 2; } finally { console.log('cleanup'); } }
for (const v of t()) { console.log(v); break; }
const it = t(); it.next(); console.log(it.return(5));
}`,
  ],
  [
    'regular expressions and generators in console.log',
    `console.log(/a+b/gi, [/x/], { r: /y/m });
function* g() { yield 1; }
console.log(g(), [g()], 'a'.matchAll(/a/g));
console.log('2024-03'.match(/(?<y>\\d+)-(?<m>\\d+)/));
console.log(String.raw, g);`,
  ],
  [
    'symbols and the iteration protocol',
    `const s = Symbol('id'), t = Symbol();
const o = { a: 1, [s]: 2, [Symbol.for('k')]: 3 };
console.log(o, Object.keys(o), o[s], typeof t, t.toString(), t.description, s.description, Symbol.for('k') === Symbol.for('k'), Symbol.keyFor(Symbol.for('k')));
console.log(String(s), [s], { [s]: { x: 1 } }, Symbol.iterator, Object.prototype.toString.call(s));
try { \`\${s}\`; } catch (e) { console.log(e.message); }
try { s + 1; } catch (e) { console.log(e.message); }
try { new Symbol(); } catch (e) { console.log(e.message); }
class Range { constructor(a, b) { this.a = a; this.b = b; } *[Symbol.iterator]() { for (let i = this.a; i < this.b; i++) yield i; } }
console.log([...new Range(1, 4)], Array.from(new Range(0, 2)), Math.max(...new Range(0, 5)));
const [x, , z] = new Range(5, 9); console.log(x, z);
const manual = { [Symbol.iterator]() { let n = 0; return { next() { n++; return n <= 3 ? { value: n * 10, done: false } : { value: undefined, done: true }; }, return() { console.log('closed'); return {}; } }; } };
for (const v of manual) { console.log(v); if (v === 20) break; }
console.log([...manual]);
const arr = ['a', 'b']; const it = arr[Symbol.iterator](); console.log(it.next(), it.next(), it.next(), it);
console.log([...arr.entries()], [...arr.keys()], [...'hé'[Symbol.iterator]()], 'x'[Symbol.iterator]());
function* g() { yield* manual; } console.log([...g()]);
const m = { [Symbol.toStringTag]: 'Custom' }; console.log(Object.prototype.toString.call(m), String(m));
class Tagged { get [Symbol.toStringTag]() { return 'T'; } } console.log(Object.prototype.toString.call(new Tagged()));
const fns = { [s]() {}, [Symbol()]: function () {} }; console.log(fns[s].name);
try { for (const q of {}) {} } catch (e) { console.log(e.constructor.name); }
console.log(arr[Symbol.iterator] === arr.values, typeof Symbol.asyncIterator);`,
  ],
  [
    'async functions, promises, and timers',
    `const log = (...a) => console.log(...a);
async function a1() { log('a1 start'); await a2(); log('a1 end'); }
async function a2() { log('a2'); }
log('script start');
setTimeout(() => log('timeout 0'), 0);
setTimeout(() => log('timeout 10'), 10);
setTimeout(() => log('timeout 5'), 5);
a1();
new Promise((resolve) => { log('p1'); resolve(); }).then(() => log('then1')).then(() => log('then2'));
queueMicrotask(() => log('micro'));
Promise.resolve().then(() => log('r1')).then(() => log('r2')).then(() => log('r3'));
(async () => { return Promise.resolve('x'); })().then((v) => log('return promise', v));
Promise.resolve(1).finally(() => log('fin')).then((v) => log('after fin', v));
Promise.reject(new Error('boom')).catch((e) => log('caught', e.message));
log('script end');
const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
(async () => {
  const [x, y] = await Promise.all([sleep(30, 'x'), sleep(20, 'y'), 3]);
  log('all', x, y);
  log('race', await Promise.race([sleep(50, 'slow'), sleep(40, 'fast')]));
  log(await Promise.allSettled([Promise.reject(1), 2]));
  try { await Promise.any([Promise.reject(1)]); } catch (e) { log(e.constructor.name, e.message, e.errors); }
  for (const t of [3, 1, 2]) { await sleep(t * 10); log('loop', t); }
  try { await (async () => { throw new TypeError('inner'); })(); } catch (e) { log('caught', e.name); }
  const thenable = { then(res) { log('thenable then'); res(42); } };
  log('thenable', await thenable);
  const o = { async m(n) { await null; return n * 2; } };
  log('method', await o.m(4));
  class K { static async s() { return 'static'; } }
  log(await K.s(), typeof K.s, Object.prototype.toString.call(K.s()));
  log(Promise.resolve(5), new Promise(() => {}), (async () => {})(), async function named() {}, async () => {});
  const rejected = Promise.reject('r'); rejected.catch(() => {}); log(rejected, [Promise.resolve({ a: [1] })]);
})();`,
  ],
  [
    'timers that queue microtasks',
    `setTimeout(() => { console.log('t1'); Promise.resolve().then(() => console.log('m in t1')); }, 0);
setTimeout(() => console.log('t2'), 0);
const id = setTimeout(() => console.log('never'), 1); clearTimeout(id);`,
  ],
  [
    'BigInts',
    `let f = 1n; for (let i = 1n; i <= 25n; i++) f *= i; console.log(f, String(f), \`\${f}\`, f.toString(16));
console.log(7n / 2n, -7n / 2n, -7n % 3n, 2n ** 100n, 1n << 70n, -9n >> 2n, 5n & 3n, 5n | 3n, 5n ^ 3n, ~5n, -(-3n));
console.log(1n < 2, 2n > 1.5, 1n == 1, 1n === 1, 0n ? 'y' : 'n', !0n, typeof 1n, BigInt(42), BigInt('0x1f'), BigInt(true), Number(12n), parseInt('9n'));
console.log([1n, 22n, 333n, 4444n, 5n, 6n, 77777n], { big: 10n ** 20n }, 0x10n, 0b11n, 0o7n, 1_000n);
for (const bad of [() => 1n + 1, () => +1n, () => 1n / 0n, () => 2n ** -1n, () => 1n >>> 1n, () => BigInt(1.5), () => BigInt('x'), () => new BigInt(1), () => Math.max(1n), () => 1n < Symbol()]) {
  try { bad(); } catch (e) { console.log(e.name + ': ' + e.message); }
}
console.log(BigInt.asIntN(8, 255n), BigInt.asUintN(8, -1n), [3n, 1n, 2n].sort(), [10n, 9n].sort((a, b) => (a < b ? -1 : 1)), Object.prototype.toString.call(1n));
let n = 5n; n++; n += 2n; console.log(n, n-- , --n, 3n * -1n, (123n).toLocaleString(), 12345678901234567890n.toLocaleString());
console.log(1n + '1', '' + 2n, [1n].includes(1n), 1n.valueOf === BigInt.prototype.valueOf);`,
  ],
  [
    'async generators and for await',
    `const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
async function* countdown(n) { try { while (n > 0) { await sleep(10); yield n--; } return 'liftoff'; } finally { console.log('cleanup'); } }
(async () => {
  for await (const v of countdown(3)) console.log('got', v);
  const g = countdown(2);
  console.log(await g.next(), await g.next(), await g.next(), await g.next());
  for await (const v of countdown(5)) { if (v < 4) break; console.log('early', v); }
  for await (const v of [sleep(5, 'a'), 'b', Promise.resolve('c')]) console.log(v);
  const custom = { [Symbol.asyncIterator]() { let i = 0; return { next: async () => (i < 2 ? { value: i++, done: false } : { done: true }) }; } };
  for await (const v of custom) console.log('custom', v);
  async function* fails() { yield 1; throw new Error('gen failed'); }
  try { for await (const v of fails()) console.log('f', v); } catch (e) { console.log('caught', e.message); }
  const r = countdown(9); await r.next(); console.log(await r.return('stop'), await r.next());
  console.log(countdown, countdown(1), Object.prototype.toString.call(countdown(1)), typeof countdown(1)[Symbol.asyncIterator]);
  async function* echo() { let received = 'start'; while (true) received = yield received; }
  const e = echo(); console.log((await e.next('x')).value, (await e.next('y')).value, (await e.next('z')).value);
  const order = []; const q = (async function* () { yield 'a'; yield 'b'; })();
  await Promise.all([q.next().then((x) => order.push(x.value)), q.next().then((x) => order.push(x.value)), q.next().then((x) => order.push(x.done))]);
  console.log(order);
})();`,
  ],
  [
    'object literal prototypes and intervals',
    `const o = { __proto__: { inherited: 1 }, own: 2, m() { return super.inherited; } };
console.log(o.inherited, o.m(), Object.getPrototypeOf(o).inherited);
let count = 0; const id = setInterval(() => { count++; console.log('tick', count); if (count === 3) clearInterval(id); }, 100);`,
  ],
  [
    'yield* in async generators',
    `async function* inner() { yield 1; yield 2; }
async function* outer() { yield* inner(); yield* [3, Promise.resolve(4)]; }
(async () => { for await (const v of outer()) console.log(v); })();
async function* src() { try { const got = yield 'a'; console.log('src got', got); yield 'b'; } finally { console.log('src fin'); } }
async function* wrap() { const r = yield* src(); console.log('r', r); }
(async () => {
  const w = wrap(); console.log(await w.next(), await w.next('hello'), await w.return('bye'), await w.next());
  const w2 = wrap(); await w2.next(); try { await w2.throw(new Error('t')); } catch (e) { console.log('thrown', e.message); }
})();`,
  ],
  [
    'using declarations',
    `try { { using a = 1; } } catch (e) { console.log(e.constructor.name, e.message); }
try { { using a = {}; } } catch (e) { console.log(e.constructor.name, e.message); }
const r = (n, fail) => ({ [Symbol.dispose]() { console.log('dispose', n); if (fail) throw new Error('d' + n); } });
try { { using a = r(1, true), b = r(2, true); throw new Error('body'); } } catch (e) { console.log(e.constructor.name, e.message, e.error?.message, e.suppressed?.message, e.suppressed?.error?.message, e.suppressed?.suppressed?.message); }
function f() { using x = r('f'); return 'ret'; } console.log(f());
for (using q of [r('q1'), r('q2')]) console.log('iter');
{ using n = null; console.log('null ok'); }
console.log(typeof Symbol.dispose, String(Symbol.asyncDispose), typeof SuppressedError);
(async () => {
  const ar = (n) => ({ async [Symbol.asyncDispose]() { console.log('async dispose', n); } });
  { await using a = ar(1), b = r(2); console.log('in async'); }
  for (await using c of [ar(3)]) console.log('iter async');
})();`,
  ],
  [
    'await and yield inside expressions',
    `const v = (x) => Promise.resolve(x);
(async () => {
  const obj = { a: await v(1), [await v('k')]: 2, ...(await v({ s: 3 })), m() { return 'm'; }, get g() { return 'g'; } };
  console.log(obj, obj.m(), obj.g);
  console.log((await v(null))?.x, (await v({ x: { y: 5 } }))?.x.y, (await v(undefined))?.x.y.z);
  for (const x of await v([1, 2])) console.log('for', x);
  let i = 0; while (await v(i < 2)) i++; console.log('while', i);
  switch (await v(2)) { case await v(1): console.log('one'); break; case await v(2): console.log('two'); }
  const arr = [0, 0]; arr[await v(1)] = await v(9); console.log(arr);
  let n = 1; n += await v(2); n *= await v(3); console.log(n);
  console.log(\`t\${await v('x')}y\${await v('z')}\`, [...(await v([1, 2])), await v(3)], new Array(await v(2)).length);
  if (await v(true)) console.log('if'); else console.log('else');
  try { throw await v(new Error('thrown')); } catch (e) { console.log(e.message); } finally { console.log(await v('fin')); }
  console.log(await v(1) + await v(2), (await v(false)) || (await v('or')), await v(true) ? await v('a') : 'b', typeof await v(1), -(await v(4)));
  const f = async () => (await v('arrow'));
  console.log(await f(), await (async function () { return await v('ret'); })());
  function* g() { const o = { a: yield 1, b: yield 2 }; return o; }
  const it = g(); it.next(); it.next('A'); console.log(it.next('B'));
})();
(async () => {
  const api = { name: 'api', hello(x) { return this.name + x; } };
  const v = (x) => Promise.resolve(x);
  console.log((await v(api)).hello('!'), (await v(api))['hello']('?'), (await v((x) => x * 2))(4), (await v(null))?.hello(1), api.missing?.(await v(1)));
  class K { constructor(a) { this.a = a; } }
  console.log(new (await v(K))(await v(7)));
})();`,
  ],
  [
    'private members of other objects',
    `class T { #f = 1; get #g() { return 1; } #m() {} static rf(o) { return o.#f; } static rg(o) { return o.#g; } static rm(o) { return o.#m(); } static wf(o) { o.#f = 1; } static wg(o) { o.#g = 1; } static wm(o) { o.#m = 1; } static sm(o) { return o.#m; } }
for (const k of ['rf', 'rg', 'rm', 'wf', 'wg', 'wm', 'sm']) try { T[k]({}); } catch (e) { console.log(k, e.message); }
class S { static #s = 1; static #sm() {} static r(o) { return o.#s; } static m(o) { return o.#sm(); } } for (const k of ['r', 'm']) try { S[k]({}); } catch (e) { console.log(k, e.message); }`,
  ],
  [
    'console.dir, group, count, and assert',
    `console.info('info', 1); console.debug('debug'); console.dir({ a: { b: { c: { d: 1 } } } }); console.dir([1], { depth: 0 });
console.group('G'); console.log('inside'); console.group(); console.log('deeper'); console.groupEnd(); console.groupEnd(); console.log('out');
console.count(); console.count('x'); console.count(); console.countReset(); console.count();
console.assert(1 === 2, 'assert msg'); console.assert(true, 'no');
console.group('Outer', 1); console.log({ a: [1, 2, 3, 4, 5, 6, 7], b: 'x'.repeat(70) }); console.error('err\\nline'); console.groupEnd(); console.groupEnd(); console.log('after');
console.dir('str'); console.dir({ deep: { a: { b: { c: {} } } } }, { depth: null });`,
  ],
  [
    'async delegation to sync iterators',
    `async function* f() { const r = yield* (function* () { const got = yield 1; console.log('got', got); return 42; })(); console.log('r', r); return r; }
(async () => {
  const g = f(); console.log(await g.next(), await g.next('sent'), await g.next());
  for await (const x of 'ab') console.log(x);
  try { for await (const x of 5) {} } catch (e) { console.log(e.constructor.name); }
  async function* h() { yield* (function* () { try { yield 1; } finally { console.log('inner fin'); } })(); }
  const k = h(); await k.next(); console.log(await k.return('R'));
})();`,
  ],
  [
    'iterator closing and delegation',
    `function* g() { try { yield 1; yield 2; } finally { console.log('cleanup'); } }
const [a] = g(); console.log(a); let b; [b] = g(); console.log(b);
const [c, d, e] = g(); console.log(c, d, e);
const it = { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { console.log('ret'); return {}; } }; } };
const [p] = it; console.log(p);
const iter = (nt, rt) => ({ [Symbol.iterator]() { return { next() { if (nt) throw new Error('next'); return { value: 1, done: false }; }, return() { console.log('return called'); if (rt) throw new Error('ret'); return {}; } }; } });
try { for (const x of iter(true, false)) {} } catch (e) { console.log(e.message); }
try { for (const x of iter(false, true)) { throw new Error('body'); } } catch (e) { console.log(e.message); }
try { for (const x of iter(false, true)) { break; } } catch (e) { console.log(e.message); }
const bad = { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { return 1; } }; } };
try { for (const x of bad) break; } catch (e) { console.log(e.constructor.name); }
try { const [z = (() => { throw new Error('default'); })()] = [undefined]; } catch (e) { console.log(e.message); }
function* outer() { const r = yield* { [Symbol.iterator]() { let n = 0; return { next(v) { n++; console.log('next got', v); return n > 2 ? { value: 42, done: true } : { value: n, done: false }; } }; } }; console.log('r', r); }
const o = outer(); console.log(o.next('a'), o.next('b'), o.next('c'));
function* noThrow() { yield* { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { console.log('closing'); return {}; } }; } }; }
const nt = noThrow(); nt.next(); try { nt.throw(new Error('x')); } catch (e) { console.log(e.constructor.name, e.message); }
(async () => {
  const x = { [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ value: 1, done: false }); }, return() { return 1; } }; } };
  try { for await (const v of x) break; console.log('ok'); } catch (e) { console.log(e.name); }
  const y = { [Symbol.asyncIterator]() { return { next() { return Promise.reject(new Error('anext')); }, return() { console.log('should not'); return {}; } }; } };
  try { for await (const v of y) {} } catch (e) { console.log(e.message); }
})();`,
  ],
  [
    'promise combinators over failing iterables',
    `try { Promise.all(null).catch((e) => console.log('rejected', e.constructor.name)); console.log('after'); } catch (e) { console.log('thrown'); }
const it = { [Symbol.iterator]() { return { next() { throw new Error('boom'); } }; } };
Promise.race(it).catch((e) => console.log('race', e.message));
Promise.allSettled(5).catch((e) => console.log('settled', e.constructor.name));`,
  ],
  [
    'super, delete, and symbol copies with await',
    `class A { m() { return 1; } get n() { return 2; } }
class B extends A {
  m() { return 20; }
  get n() { return 30; }
  async f() {
    console.log(super[await Promise.resolve('m')](), super[await Promise.resolve('n')]);
    super[await Promise.resolve('x')] = 5; console.log(this.x);
  }
}
new B().f().then(async () => {
  const o = { x: 1, y: { z: 2 } };
  console.log(delete o[await Promise.resolve('x')], o, delete (await Promise.resolve(o)).y.z, o, delete (await Promise.resolve(null))?.q);
  const s = Symbol('s'); const src = { a: 1, [s]: 2 };
  const copy = { ...src }; const { a, ...rest } = src; console.log(copy[s], rest[s], Object.assign({}, src)[s]);
});`,
  ],
])('a program using %s runs as Node.js runs it', (_, source) => {
  expect(executeProgram('javascript', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: runOnNode(source),
  });
});

/** What Node.js prints for a script, without the colors that a FORCE_COLOR in the environment (as on CI) adds. */
function runOnNode(source: string): string {
  const { FORCE_COLOR: _, ...env } = process.env;
  return execFileSync('node', ['-e', source], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
}
