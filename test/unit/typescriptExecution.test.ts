import fs from 'node:fs';

import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const diagnosticsOf = (source: string): string[] => {
  const execution = executeProgram('typescript', source);
  if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
  return execution.diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`);
};

test.each([
  ['LF before the closing quote', "console.log('text\n');"],
  ['CRLF in an empty double-quoted string', 'console.log("\r\n");'],
  ['an even number of backslashes before a newline', "console.log('text\\\\\n');"],
])('rejects a quoted string with %s', (_description, source) => {
  expect(diagnosticsOf(source)).toContain('1: 文字列リテラルが閉じられていません。');
});

test('escaped line continuations and Unicode line separators remain valid in strings', () => {
  const source = "console.log('line\\\r\ncontinuation', 'line\u2028separator');";
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'linecontinuation line\u2028separator\n',
    uncaughtException: undefined,
  });
});

test('the turtle takes both the Japanese and the English names of its methods', () => {
  const execution = executeProgram(
    'typescript',
    `const t: Turtle = new Turtle(1, 1, 'R');
t.前に進む();
t.forward();
t.右を向く();
t.turnLeft();
if (t.前に進めるか() && !t.前のマスが塗られているか()) t.後に戻る();`
  );
  expect(execution).toMatchObject({ kind: 'executed', finalTurtles: [{ x: 1, y: 2, color: 'R', dir: 'N' }] });
});

test('a turtle an array element accessor keeps stays on the board', () => {
  const execution = executeProgram(
    'typescript',
    `function make() {
  const t = new Turtle();
  const array: Turtle[] = [];
  Object.defineProperty(array, "0", { get: () => t });
  return array;
}
const array = make();
array[0].forward();`
  );
  expect(execution).toMatchObject({ kind: 'executed', finalTurtles: [{ x: 0, y: 1 }] });
});

test('a turtle saved on the this of a plain call stays on the board for the next plain call', () => {
  const execution = executeProgram(
    'typescript',
    `function save(this: any) { this.t = new Turtle(); }
function move(this: any) { this.t.forward(); }
save();
move();`
  );
  expect(execution).toMatchObject({ kind: 'executed', finalTurtles: [{ x: 0, y: 1 }] });
});

test('a parameter property becomes a field before the fields the class declares', () => {
  const execution = executeProgram(
    'typescript',
    `class P {
  z = 3;
  constructor(public x: number, private y = 2) {}
}
class Q extends P {
  w = 5;
  constructor(public k: number) {
    super(k);
  }
}
console.log(new P(1), new Q(4));`
  );
  expect(execution).toMatchObject({
    kind: 'executed',
    stdout: 'P { x: 1, y: 2, z: 3 } Q { x: 4, y: 2, z: 3, k: 4, w: 5 }\n',
  });
});

test('types only checked before running, never change what the program does', () => {
  const execution = executeProgram(
    'typescript',
    `interface Shape { area(): number }
type Id = number;
abstract class Base { abstract name(): string; declare tag: string; }
class Square extends Base implements Shape {
  side!: number;
  name(): string { return 'square'; }
  area(): number { return this.side ** 2; }
}
const s = new Square();
s.side = <number>3;
console.log(s.area() as Id, s, Object.keys(s), (s.name() satisfies string).length);`.replace(' satisfies string', '')
  );
  expect(execution).toMatchObject({ kind: 'executed', stdout: "9 Square { side: 3 } [ 'side' ] 6\n" });
});

test.each([
  ['an enum', 'enum Color { Red }', 'enum は、この採点環境では使えません。'],
  ['a namespace', 'namespace N {}', 'namespace は、この採点環境では使えません。'],
  ['a declare statement', 'declare const x: number;', 'declare による宣言は、この採点環境では使えません。'],
  ['an import', 'import fs from "fs";', 'import や export は、この採点環境では使えません。'],
  ['a generator', 'function* g() {}', 'ジェネレータ関数は、この採点環境では使えません。'],
  ['an async function', 'async function f() {}', 'async 関数は、この採点環境では使えません。'],
  ['a decorator', 'function d(t: unknown) {}\n@d class A {}', 'デコレータは、この採点環境では使えません。'],
  ['a label', 'a: for (;;) break a;', 'ラベル付きの文は、この採点環境では使えません。'],
  [
    'the override modifier',
    'class A { m() {} }\nclass B extends A { override m() {} }',
    'override 修飾子は、この採点環境では使えません。',
  ],
  ['satisfies', 'const a = 1 satisfies number;', 'satisfies 演算子は、この採点環境では使えません。'],
  [
    'a String.raw replaced by a value that is not a function',
    'String.raw = 1 as any;\nString.raw`x${(() => { throw new Error("bad"); })()}`;',
    'タグ付きテンプレートは、この採点環境では使えません。',
  ],
  [
    'a String.raw replaced by the program',
    'String.raw = (...a: any[]) => 42 as any;\nconsole.log(String.raw`x`);',
    'タグ付きテンプレートは、この採点環境では使えません。',
  ],
  [
    'a tag spelled String.raw that names a parameter',
    'const raw = (...a: unknown[]) => 1;\nfunction f(String: { raw: typeof raw }) { return String.raw`x`; }',
    'タグ付きテンプレートは、この採点環境では使えません。',
  ],
  [
    'a computed String.raw tag replaced by the program',
    'String["raw"] = (...a: any[]) => 42 as any;\nconsole.log((String["raw"])`x`);',
    'タグ付きテンプレートは、この採点環境では使えません。',
  ],
  [
    'a parenthesized computed tag that names a String parameter',
    'const raw = (...a: unknown[]) => 1;\nfunction f(String: { raw: typeof raw }) { return (String["raw"])`x`; }',
    'タグ付きテンプレートは、この採点環境では使えません。',
  ],
  ['a Promise', 'Promise.resolve(1);', 'Promise は、この採点環境では使えません。'],
  ['a timer', 'setTimeout(() => {}, 1);', 'setTimeout などのタイマーは、この採点環境では使えません。'],
  ['a Date', 'new Date();', 'Date（日付と時刻）は、この採点環境では使えません。'],
  ['Math.random', 'Math.random();', 'Math.random は、この採点環境では使えません。'],
  [
    'Math.random through any',
    'const m: any = Math;\nconsole.log(m.random());',
    'Math.random は、この採点環境では使えません。',
  ],
  [
    'the stack of an Error through any',
    'const e: any = new Error("oops");\nconsole.log(e.stack);',
    'Error の stack は、この採点環境では使えません。',
  ],
  [
    'the stack of an Error whose prototype is removed',
    'const e: any = new Error("oops");\nObject.setPrototypeOf(e, null);\nconsole.log(e.stack);',
    'Error の stack は、この採点環境では使えません。',
  ],
  [
    'console.time through any',
    'const c: any = console;\nc.time("x");',
    'console.time は、この採点環境では使えません。',
  ],
  [
    'RegExp compile through any',
    'const r: any = /a/;\nr.compile("b");',
    'RegExp の compile は、この採点環境では使えません。',
  ],
  [
    'Math.random through an intersection whose first member declares it too',
    'const m: { random(): number } & Math = Math;\nm.random();',
    'Math.random は、この採点環境では使えません。',
  ],
  [
    'the stack of an Error through a type parameter constrained to an intersection',
    'function f<E extends { stack?: string } & Error>(e: E) { return e.stack; }',
    'Error の stack は、この採点環境では使えません。',
  ],
  [
    'a well-known symbol',
    'Symbol.iterator;',
    'Symbol.iterator などの well-known シンボルは、この採点環境では使えません。',
  ],
])('%s is not supported yet', (_, source, message) => {
  expect(diagnosticsOf(source)).toEqual([`${source.split('\n').length}: ${message}`]);
});

test('turning a function or a class into text is not supported, as Node.js shows the source tsx printed', () => {
  const source = `function add(a: number, b: number): number { return a + b; }
class A {}
console.log(String(add));
console.log(add.toString());
console.log(\`\${add}\`);
console.log('' + add);
console.log('%s', A);
let s = 'x';
s += add;
console.log(add, add.name, '%d', typeof A);
console.assert(false, '%s', add);
console.warn('%d %s', 1, add);
console.dirxml('%s', add);`;
  expect(diagnosticsOf(source)).toEqual(
    [3, 4, 5, 6, 7, 9, 11, 12, 13].map((row) => `${row}: 関数やクラスの文字列への変換は、この採点環境では使えません。`)
  );
});

test('a function turned into text through any or an array ends the program as unsupported where it runs', () => {
  const message = '関数やクラスの文字列への変換は、この採点環境では使えません。';
  expect(executeProgram('typescript', 'const f: any = () => 1;\nconsole.log(String(f));')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message }],
  });
  expect(executeProgram('typescript', 'function g() {}\nconsole.log([g].join());')).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message }],
  });
});

test('Node.js names are unknown, as the reference tsc has no Node.js types', () => {
  expect(diagnosticsOf('process.exit(0);')).toEqual([
    '1: 名前 process が見つかりません。Node.js の機能は、この採点環境では使えません。',
  ]);
});

test('a type error is reported in Japanese on its row and stops the program before it runs', () => {
  expect(
    diagnosticsOf(`console.log("never printed");
let count: number = "3";
const maybeText: string | undefined = undefined;
console.log(maybeText.length);`)
  ).toEqual([
    "2: 型 'string' を型 'number' に代入することはできません。",
    "4: 'maybeText' は 'undefined' の可能性があります。",
  ]);
});

test('incompatible native overload implementations stop execution at the learner declaration', () => {
  for (const implementation of [
    'function print(value: string) {}',
    'function open(value: number) { return value; }',
    'function focus(value: number) {}',
    'function scroll(value: string) {}',
    'function confirm(value: string) { return true; }',
    'function getSelection() { return 1; }',
    'function getSelection() { return {}; }',
    'function getSelection() {}',
  ]) {
    expect(executeProgram('typescript', `console.log("never");\n${implementation}`)).toMatchObject({
      kind: 'compileError',
      diagnostics: expect.arrayContaining([{ row: 1, message: expect.stringContaining('オーバーロード') }]),
    });
  }
});

test.each([
  ['an infinite loop', 'while (true) {}', { kind: 'limitExceeded', limit: 'operations' }],
  ['endless output', "for (;;) console.log('x'.repeat(1000));", { kind: 'limitExceeded', limit: 'output' }],
])('%s stops at the execution limits', (_, source, expected) => {
  expect(executeProgram('typescript', source)).toEqual(expected);
});

test('type checking stops at the execution limits, as the server checks programs in its own process', () => {
  const heavyTypes = Array.from(
    { length: 40 },
    (_, index) => `type D${index} = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type M${index} = { [K in \`\${D${index}}\${D${index}}\${D${index}}\${D${index}}\`]: K };
const m${index}: keyof Partial<M${index}> = "0000";`
  ).join('\n');
  expect(executeProgram('typescript', heavyTypes)).toMatchObject({ kind: 'limitExceeded' });
});

test('template literal types that double their text stop at the type-checking budget', () => {
  const aliases = Array.from({ length: 24 }, (_, index) => `type A${index + 1} = \`\${A${index}}\${A${index}}\`;`);
  const source = `type A0 = "x";\n${aliases.join('\n')}\nconst value: A24 = "x";`;
  expect(executeProgram('typescript', source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('nested loops are checked once per loop,not once per pass of every enclosing loop', () => {
  const depth = 40;
  const loops = Array.from({ length: depth }, (_, index) => `for (let i${index} = 0; i${index} < 1; i${index}++) {`);
  const source = `let x: number | string = 1;\n${loops.join('\n')}\nx = x === 1 ? "a" : 1;\n${'}'.repeat(depth)}\nconsole.log(x);`;
  expect(executeProgram('typescript', source)).toMatchObject({ kind: 'executed', stdout: 'a\n' });
});

test('intersection expansion stops at the type-checking budget', () => {
  const factors = Array.from({ length: 21 }, (_, index) => `({a${index}: 1} | {a${index}: 2})`);
  expect(executeProgram('typescript', `type Product = ${factors.join(' & ')};`)).toMatchObject({
    kind: 'limitExceeded',
  });
});

test('console.table stops before expanding repeated cells or table padding past the output limit', () => {
  for (const source of [
    'console.table(Array(10000).fill("x".repeat(10000)));',
    'const cells = Array(1000).fill(""); cells[0] = "x".repeat(1000); console.table(cells);',
  ]) {
    expect(executeProgram('typescript', source)).toEqual({ kind: 'limitExceeded', limit: 'output' });
  }
});

test('computed class and object members reject well-known symbols before execution', () => {
  const source = `class A { [Symbol.iterator]() { return [1, 2].values(); } }
const object = { [Symbol.iterator]() { return [1].values(); } };
class B { get [Symbol.toStringTag]() { return 'B'; } }
const tagged = { get [Symbol.toStringTag]() { return 'tagged'; } };`;
  const execution = executeProgram('typescript', source);
  if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
  expect(execution.diagnostics.map(({ row }) => row)).toEqual([0, 1, 2, 3]);
  expect(execution.diagnostics.every(({ message }) => message.includes('この採点環境では使えません'))).toBe(true);
});

test('reading unavailable values and calling unavailable methods are rejected through indirection', () => {
  const sources = [
    'const {stack} = new Error("bad"); console.log(stack);',
    'const {random} = Math; console.log(random());',
    'const key = "random"; const {[key]: random} = Math; random();',
    'const key = "stack"; const {[key]: stack} = new Error("bad");',
    'const key = "random" as "random" | "abs"; const {[key]: selected} = Math; selected(1);',
    'function select<K extends "random">(key: K) { const {[key]: selected} = Math; selected(); } select("random");',
    'const key = "random"; let selected: () => number; ({[key]: selected} = Math); selected();',
    'const key = "stack"; let selected: string | undefined; ({[key]: selected = "none"} = new Error("bad"));',
    'console["time"]("start");',
    'function show(error: Error | TypeError) { const {stack} = error; console.log(stack); }',
  ];
  for (const source of sources) {
    const execution = executeProgram('typescript', source);
    if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
    expect(execution.diagnostics.some(({ message }) => message.includes('この採点環境では使えません'))).toBe(true);
  }
});

test('recursive type instantiation stops before the host stack is exhausted', () => {
  for (const argument of ['T', 'T[]']) {
    const source = `type Loop<T> = T extends any ? Loop<${argument}> : never; const value: Loop<number> = 1;`;
    expect(executeProgram('typescript', source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
  }
});

test('template literal type products of 100,000 combinations or more are rejected before allocating them', () => {
  const declarations = Array.from(
    { length: 12 },
    (_, group) => `type Part${group} = ${Array.from({ length: 100 }, (_, index) => group * 100 + index).join(' | ')};`
  ).join('\n');
  const source = `${declarations}\ntype Part = ${Array.from({ length: 12 }, (_, index) => `Part${index}`).join(' | ')};\ntype Product = \`\${Part}\${Part}\`;`;
  expect(executeProgram('typescript', source)).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 13, message: 'この式の型は、表せないほど複雑な共用体型になります。' }],
  });
});

test('legacy HTML builders enforce string limits before escaping and wrapping', () => {
  for (const source of [
    'console.log("x".repeat(1000000).bold().length);',
    'let text = "x"; for (let i = 0; i < 16; i++) text = text.link(text); console.log(text.length);',
  ]) {
    expect(executeProgram('typescript', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'RangeError: Invalid string length',
    });
  }
});

test('unsupported type syntax and omitted host globals stop execution before effects', () => {
  for (const source of [
    'console.log("never"); const value: unique symbol = Symbol();',
    'console.log("never"); const value: unique  symbol = Symbol();',
    'console.log("never"); const value: unique /* type */ symbol = Symbol();',
    'console.log("never"); const make = Uint8Array; make(3);',
    'console.log("never"); let values: Uint8Array;',
    'console.log("never"); type Constructor = typeof Uint8Array;',
    'console.log("never"); type Formatter = Intl.NumberFormat;',
    'console.log("never"); type Instance = WebAssembly.Instance;',
  ]) {
    const execution = executeProgram('typescript', source);
    expect(execution).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ message: expect.stringContaining('この採点環境では使えません。') }],
    });
  }
});

test('RegExp match state starts fresh for each execution', () => {
  executeProgram('typescript', '/(a)/.test("a");');
  expect(executeProgram('typescript', 'console.log(RegExp.$1 === "", RegExp.input === "");')).toMatchObject({
    kind: 'executed',
    stdout: 'true true\n',
  });
});

test('reflected unavailable methods still reject invocation and error stacks reject reflection', () => {
  for (const source of [
    'Object.getOwnPropertyDescriptor(Math, "random")!.value();',
    'Object.getOwnPropertyDescriptors(RegExp.prototype).compile.value!.call(/a/, "b");',
    'Object.getOwnPropertyDescriptor(console, "time")!.value("start");',
    'Object.getOwnPropertyNames(new Error("bad"));',
    'Object.getOwnPropertyDescriptor(new Error("bad"), "stack");',
  ]) {
    expect(executeProgram('typescript', source)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ message: expect.stringContaining('この採点環境では使えません。') }],
    });
  }
});

test.each([
  'function f(x=1){type T=number;"use strict";return x;}console.log(f());',
  'const f=(...x:number[])=>{interface I{}"use strict";return x.length;};console.log(f(1));',
  'const o={f({x}:{x:number}){type T=number;"use strict";return x;}};console.log(o.f({x:2}));',
  'class C{constructor(public x=1){interface I{}"use strict";}}console.log(new C().x);',
])('non-simple parameters reject a strict directive exposed by erasure: %s', (source) => {
  expect(diagnosticsOf(source).join('\n')).toContain("'use strict'");
});

test.each([
  'function f(x=1){;type T=number;"use strict";return x;}console.log(f());',
  'function f(x:number){type T=number;"use strict";return x;}console.log(f(1));',
])('type erasure preserves valid directive boundaries: %s', (source) => {
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test('apply budgets an oversized array-like list before reading its indices or calling its target', () => {
  for (const length of ['1000001', 'Number.MAX_SAFE_INTEGER', 'Infinity']) {
    const source = `function target() { console.log('called'); return 7; }
const list: any = {
  get length() { console.log('length'); return ${length}; },
  get 0() { console.log('index'); throw new Error('index read'); },
};
target.apply(undefined, list);`;
    expect(executeProgram('typescript', source)).toMatchObject({
      kind: 'executed',
      stdout: 'length\n',
      uncaughtException: 'RangeError: Out of memory',
    });
  }
});

test('apply argument lists share the allocation budget and a later program starts with a fresh budget', () => {
  const source = `const reserved = new Array(800000);
console.log(reserved.length);
function target() { console.log('called'); return 7; }
const list: any = {
  get length() { console.log('length'); return 300000; },
  get 0() { console.log('index'); throw new Error('index read'); },
};
Function.prototype.apply.call(target, undefined, list);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: '800000\nlength\n',
    uncaughtException: 'RangeError: Out of memory',
  });
  expect(
    executeProgram('typescript', 'function target() { return 7; } console.log(target.apply(undefined, []));')
  ).toMatchObject({ kind: 'executed', stdout: '7\n', uncaughtException: undefined });
});

test('apply reads length once before ordered own and inherited indices and keeps empty lists empty', () => {
  const source = `function target() { console.log('call', arguments.length, arguments[0], arguments[1]); }
const list: any = {
  get length() { console.log('length'); return { valueOf() { console.log('valueOf'); return 2.9; } }; },
  get 0() { console.log('own'); return 'first'; },
};
Object.setPrototypeOf(list, { get 1() { console.log('inherited'); return 'second'; } });
target.apply(undefined, list);
const empty: any = { get length() { console.log('empty length'); return 0; }, get 0() { throw new Error('index read'); } };
target.apply(undefined, empty);
target.apply(undefined, null as any);
target.apply(undefined, undefined as any);
target.apply(undefined, Object('ab') as any);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout:
      'length\nvalueOf\nown\ninherited\ncall 2 first second\nempty length\ncall 0 undefined undefined\ncall 0 undefined undefined\ncall 0 undefined undefined\ncall 2 a b\n',
    uncaughtException: undefined,
  });
});

test('nullable assignment diagnostics retain the source and target types reported by TypeScript', () => {
  const fixture = new URL(
    '../fixtures/typescriptTypeErrors/rejects-nullable-assignment-message-types.ts.txt',
    import.meta.url
  );
  const reference = fs.readFileSync(
    new URL('../fixtures/typescriptTypeErrors/rejects-nullable-assignment-message-types.out', import.meta.url),
    'utf8'
  );
  const expected = reference.split('\n').flatMap((line) => {
    const match =
      /^\((\d+),\d+\).*?[Tt]ype '(.+?)' (?:is not assignable to (?:type|parameter of type)|does not satisfy the constraint) '(.+?)'\./.exec(
        line
      );
    return match ? [{ row: Number(match[1]) - 1, source: match[2], target: match[3] }] : [];
  });
  const execution = executeProgram('typescript', fs.readFileSync(fixture, 'utf8'));
  if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
  expect(execution.diagnostics.map((diagnostic) => diagnostic.row)).toEqual(
    expected.map((diagnostic) => diagnostic.row)
  );
  for (const [index, diagnostic] of execution.diagnostics.entries()) {
    const reported = /^型 '(.+?)' (?:を型|の引数を型|は制約) '(.+?)'/.exec(diagnostic.message);
    expect(reported?.slice(1)).toEqual([expected[index].source, expected[index].target]);
  }
});
