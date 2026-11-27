import fs from 'node:fs';

import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const diagnosticsOf = (source: string): string[] => {
  const execution = executeProgram('typescript', source);
  if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
  return execution.diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`);
};

test('checks separately written conditional template types with inferred placeholders', () => {
  const source = `function consume<T extends string>(value: T extends \`x\${infer S}\` ? S : never) {
  console.log(value);
}
function forward<T extends string>(value: T extends \`x\${infer R}\` ? R : never) {
  consume<T>(value);
}
function parseId<T extends string>(value: T): T extends \`id-\${infer N}\` ? N : never {
  return value.slice(3) as T extends \`id-\${infer M}\` ? M : never;
}
forward<'xhello'>('hello');
console.log(parseId('id-42'));`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'hello\n42\n',
    uncaughtException: undefined,
  });
});

test('infers constrained and compound placeholders from template literal types', () => {
  const source = `type Tail<S> = S extends \`id-\${infer T}\` ? T : never;
type NumericTail<S> = S extends \`id-\${infer N extends number}\` ? N : never;
const plain: Tail<\`id-\${number}\`> = '42';
const nested: Tail<\`id-item-\${number}\`> = 'item-42';
const numeric: NumericTail<\`id-\${number}\`> = 42;
console.log(plain, nested, numeric);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: '42 item-42 42\n',
    uncaughtException: undefined,
  });
});

test('reports only the invalid argument when conditional template types agree', () => {
  const source = `function copy<T extends string>(values: Array<T extends \`a\${infer R}\` ? R : 'b'>): Array<T extends \`a\${infer S}\` ? S : 'b'> {
  return values;
}
copy(['1']);`;
  expect(diagnosticsOf(source)).toEqual([expect.stringMatching(/^4: .*"1".*"b"/)]);
});

test('relates conditional types with the same string mapping inside and outside templates', () => {
  const source = `function consume<T extends string>(value: T extends Uppercase<infer S> ? S : never) {
  console.log(value);
}
function forward<T extends string>(value: T extends Uppercase<infer W> ? W : never) {
  consume<T>(value);
}
function parse<T extends string>(value: T): T extends \`x-\${Uppercase<infer W>}\` ? W : never {
  return value as unknown as T extends \`x-\${Uppercase<infer M>}\` ? M : never;
}
forward<'OK'>('OK');
console.log(parse('x-OK'));`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'OK\nx-OK\n',
    uncaughtException: undefined,
  });
});

test('uses infer constraints in string mapping holes without losing adjacent captures', () => {
  const source = `type Upper<T> = T extends \`\${Uppercase<infer A>}\` ? A : never;
type Lower<T> = T extends \`\${Lowercase<infer A>}\` ? A : never;
type Capital<T> = T extends \`x-\${Capitalize<infer A>}\` ? A : never;
type Pair<T> = T extends \`\${Uncapitalize<infer A>}-\${infer B}\` ? [A, B] : never;
type First<T> = T extends \`\${infer A}\${infer B}\` ? A : 'fallback';
const a: Upper<'A'> = 'other';
const b: Lower<'ab'> = 'other';
const c: Capital<'x-Ab'> = 'other';
const d: Pair<'alpha-b'> = ['other', 'b'];
const e: First<''> = 'fallback';
console.log(a, b, c, d, e);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: "other other other [ 'other', 'b' ] fallback\n",
    uncaughtException: undefined,
  });
  expect(diagnosticsOf(`${source}\nconst bad: Upper<'a'> = 'other';`)).toEqual([
    expect.stringMatching(/^12: .*'never'/),
  ]);
});

test('terminates recursive template types when a constraint cannot fill their holes', () => {
  const source = `type Twice<S extends string> = S extends \`\${infer H}\${infer R}\` ? \`\${H}\${H}\${Twice<R>}\` : '';
type Pair<S> = S extends \`\${infer H}\${infer R}\` ? [H, R] : 'miss';
const broad: Pair<string> = 'miss';
const repeated: Twice<'abc'> = 'aabbcc';
const empty: Twice<string> = '';
console.log(broad, repeated, empty);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'miss aabbcc \n',
    uncaughtException: undefined,
  });
});

test('checks overlap with the type parameter in conditional assertions', () => {
  const source = `function cast<T extends string>(value: T) {
  return value as T extends \`x-\${infer R}\` ? R : never;
}
function numeric<T extends number>(value: T) {
  return value as T extends 1 ? 2 : 3;
}
function constrained<T extends string[]>(value: T) {
  return value as T extends Array<infer R extends string> ? R : never;
}
function unconstrained<T extends string[]>(value: T) {
  return value as T extends Array<infer R> ? R : never;
}
function sliced<T extends string>(value: T) {
  return value.slice(2) as T extends \`x-\${infer R}\` ? R : never;
}
function retain<T extends string>(value: T) {
  return value as T extends 'a' ? T : string;
}`;
  expect(diagnosticsOf(source)).toEqual([
    expect.stringMatching(/^2: .*十分に重ならない/),
    expect.stringMatching(/^5: .*十分に重ならない/),
    expect.stringMatching(/^8: .*十分に重ならない/),
  ]);
});

test('checks overlap through nested conditional branches and aliases', () => {
  const source = `type Inner<T> = T extends \`x\${infer R}\` ? R : never;
function fromAlias<T extends string>(value: T) {
  return value as (T extends string ? Inner<T> : never);
}
function fromFalseBranch<T extends string>(value: T) {
  return value as (T extends string ? never : (T extends Uppercase<infer W> ? W : never));
}
function fromArray<T extends string[]>(value: T) {
  return value as (T extends unknown ? (T extends Array<infer U> ? U : never) : never);
}
function assign<T extends string>(value: T extends string ? Inner<T> : never) {
  const result: T = value;
  return result;
}`;
  expect(diagnosticsOf(source)).toEqual([
    expect.stringMatching(/^3: .*十分に重ならない/),
    expect.stringMatching(/^6: .*十分に重ならない/),
    expect.stringMatching(/^12: .*代入することはできません/),
  ]);
});

test('uses the inferred branch constraint for nested conditional casts and assignments', () => {
  const source = `type Inner<T> = T extends \`x\${infer R}\` ? (R extends \`y\${infer S}\` ? S : never) : never;
type Nested<T> = T extends string ? Inner<T> : never;
type Deeper<T> = T extends string ? (T extends \`x\${infer R}\` ? (R extends \`y\${infer S}\` ? (S extends \`z\${infer U}\` ? U : never) : never) : never) : never;
function cast<T extends string>(value: T) { return value as Nested<T>; }
function assign<T extends string>(value: Nested<T>) { const result: T = value; return result; }
function peel<T extends string>(value: T) { return value as Deeper<T>; }
console.log(cast('xy-one'), assign<'xy-two'>('-two'), peel('xyz-three'));`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'xy-one -two xyz-three\n',
    uncaughtException: undefined,
  });
});

test('infers mapped keys before choosing a conditional branch', () => {
  const source = `type KeysOf<T> = T extends Record<infer K, unknown> ? K : never;
type EntriesOf<T> = T extends Record<infer K, infer V> ? [K, V] : never;
type UsingIndex<T> = T extends { [P in infer K]: P } ? K : never;
type ForKey<K extends PropertyKey> = { a: 1 } extends Record<K, infer V> ? V : 'missing';
const key: KeysOf<{ a: 1; b: 2 }> = 'a';
const entry: EntriesOf<{ a: 1 }> = ['a', 1];
const ownKey: UsingIndex<{ prop: 'prop' }> = 'prop';
const value: ForKey<'a'> = 1;
const absent: ForKey<'b'> = 'missing';
console.log(key, entry, ownKey, value, absent);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: "a [ 'a', 1 ] prop 1 missing\n",
    uncaughtException: undefined,
  });
});

test.each([
  ['LF before the closing quote', "console.log('text\n');"],
  ['CRLF in an empty double-quoted string', 'console.log("\r\n");'],
  ['an even number of backslashes before a newline', "console.log('text\\\\\n');"],
])('rejects a quoted string with %s', (_description, source) => {
  expect(diagnosticsOf(source)).toEqual(['1: 文字列リテラルが閉じられていません。']);
});

test('rejects an unfinished template ending in a backslash', () => {
  expect(diagnosticsOf('console.log(`hello\\')).toEqual(['1: 書き方に誤りがあります。']);
});

test('hidden error inspection lists own properties alongside the headline', () => {
  const execution = executeProgram(
    'typescript',
    `const error = new TypeError('broken');
error.name = 'Custom';
console.log(error);
console.dir(error, {showHidden: true});
console.log('%o', error);`
  );
  expect(execution).toMatchObject({
    kind: 'executed',
    stdout: `Custom: broken
Custom: broken { [message]: 'broken', name: 'Custom' }
Custom: broken { [message]: 'broken', name: 'Custom' }
`,
  });
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
  [
    'an import of another file',
    'import { f } from "./other";',
    "モジュール './other' の import は、この採点環境では使えません。",
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
    'the stack of an Error through a type parameter constrained to an intersection',
    'function f<E extends { stack?: string } & Error>(e: E) { return e.stack; }',
    'Error の stack は、この採点環境では使えません。',
  ],
  [
    'a well-known symbol',
    'Symbol.toPrimitive;',
    'Symbol.toPrimitive などの well-known シンボルは、この採点環境では使えません。',
  ],
  [
    'a well-known symbol through any',
    'const constructor: any = Symbol;\nconsole.log(constructor.hasInstance);',
    'Symbol.hasInstance などの well-known シンボルは、この採点環境では使えません。',
  ],
  [
    'a reflected well-known symbol',
    'const constructor: any = Symbol;\nconsole.log(Object.getOwnPropertyDescriptor(constructor, "toStringTag")?.value);',
    'Symbol.toStringTag などの well-known シンボルは、この採点環境では使えません。',
  ],
])('%s is not supported yet', (_, source, message) => {
  expect(diagnosticsOf(source)).toEqual([`${source.split('\n').length}: ${message}`]);
});

test('reflecting keys cannot hand a well-known symbol to a TypeScript program', () => {
  const expose = 'const keys = Object.getOwnPropertySymbols(Promise.prototype);';
  const message = '1: Symbol.toStringTag などの well-known シンボルは、この採点環境では使えません。';
  expect(diagnosticsOf(`${expose}\nconsole.log(keys[0]);`)).toEqual([message]);
  expect(
    diagnosticsOf(`${expose}
const tagged: any = {};
tagged[keys[0]] = "Tagged";
console.log(String(tagged));`)
  ).toEqual([message]);
  expect(executeProgram('javascript', `${expose}\nconsole.log(keys[0] === Symbol.toStringTag);`)).toMatchObject({
    kind: 'executed',
    stdout: 'true\n',
  });
});

test('symbol reflection preserves user-created symbols and builtin shape queries', () => {
  const source = `const key = Symbol('Symbol.iterator');
const keys = Object.getOwnPropertySymbols({[key]: 1});
const descriptors = Object.getOwnPropertyDescriptors(Array.prototype);
console.log(keys[0] === key, Object.getOwnPropertyNames(descriptors).includes('length'));
console.log(Object.hasOwn(Symbol, 'iterator'), Object.getOwnPropertyNames(Symbol).includes('iterator'));`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'true true\ntrue true\n',
  });
});

test('independent converter and checker errors on one line are both reported', () => {
  expect(diagnosticsOf('const a; let b: number = "x";')).toEqual([
    '1: const で宣言する変数には初期値が必要です。',
    "1: 型 'string' を型 'number' に代入することはできません。",
  ]);
  expect(diagnosticsOf(String.raw`const p\u0061rt: Missing; console.log(another);`)).toEqual([
    '1: const で宣言する変数には初期値が必要です。',
    '1: 型 Missing が見つかりません。',
    '1: 名前 another が見つかりません。',
  ]);
});

test('Turtle rejects unsupported constructor shapes', () => {
  const diagnostics = diagnosticsOf('new Turtle(3);\nnew Turtle(1, 2, undefined);');
  expect(diagnostics.map((message) => Number(message.split(':')[0]))).toEqual([1, 2]);
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

test('Node.js features beyond the standard streams and fs are unavailable', () => {
  expect(diagnosticsOf('process.cwd();')).toEqual(['1: process.cwd は、この採点環境では使えません。']);
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

test('computed class and object members reject well-known symbols other than iteration ones before execution', () => {
  const source = `class A { [Symbol.toPrimitive]() { return 1; } }
const object = { [Symbol.hasInstance]() { return true; } };
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
    'const {time} = console; time("a");',
    'const key = "time"; const {[key]: time} = console; time("a");',
    'const key = "stack"; const {[key]: stack} = new Error("bad");',
    'const key = "time" as "time" | "log"; const {[key]: selected} = console; selected("a");',
    'function select<K extends "time">(key: K) { const {[key]: selected} = console; selected(); } select("time");',
    'const key = "time"; let selected: (label?: string) => void; ({[key]: selected} = console); selected();',
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

test('Unicode normalization checks the length after expansion', () => {
  const source = 'console.log("ﬃ".repeat(400000).normalize("NFKD").length);';
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'RangeError: Invalid string length',
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

test('omitted host globals stop execution before effects', () => {
  for (const source of [
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

test.each([
  'console.log(RegExp.$1);',
  '/(a)/.test("a"); console.log({ key: 1 }); console.log(RegExp.lastMatch);',
  'RegExp.input = "override";',
  'const C: any = RegExp; console.log(C["$&"]);',
  'const C: any = RegExp; C.$_ = "override";',
  'Object.getOwnPropertyDescriptor(RegExp, "$1")!.get!.call(RegExp);',
  'Object.getOwnPropertyDescriptor(RegExp, "input")!.set!.call(RegExp, "override");',
])('RegExp legacy statics are unavailable through %s', (source) => {
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'RegExp の旧式の静的プロパティは、この採点環境では使えません。' }],
  });
});

test('reflected unavailable methods and error stack accessors reject invocation', () => {
  for (const source of [
    'Object.getOwnPropertyDescriptors(RegExp.prototype).compile.value!.call(/a/, "b");',
    'Object.getOwnPropertyDescriptor(console, "time")!.value("start");',
    'const e = new Error("bad"); Object.getOwnPropertyDescriptor(e, "stack")!.get!.call(e);',
    'const e = new Error("bad"); Object.getOwnPropertyDescriptors(e).stack!.set!.call(e, "fake");',
    'const x: any = {}; (Error as any).captureStackTrace(x); console.log(x.stack);',
    'const x = {}; (Error as any).captureStackTrace(x); Object.getOwnPropertyDescriptor(x, "stack")!.get!.call(x);',
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

test('nullable relation diagnostics retain TypeScript error heads and constituent hints', () => {
  const fixture = new URL(
    '../fixtures/typescriptTypeErrors/rejects-nullable-assignment-message-types.ts.txt',
    import.meta.url
  );
  const reference = fs.readFileSync(
    new URL('../fixtures/typescriptTypeErrors/rejects-nullable-assignment-message-types.out', import.meta.url),
    'utf8'
  );
  const referenceLines = reference.split('\n');
  const expected = referenceLines.flatMap((line, index) => {
    const match =
      /^\((\d+),\d+\).*?[Tt]ype '(.+?)' (?:is not assignable to (?:type|parameter of type)|does not satisfy the constraint) '(.+?)'\./.exec(
        line
      );
    if (!match) return [];
    const detail = /^  Type '(.+?)' is not assignable to type '(.+?)'\./.exec(referenceLines[index + 1]);
    const missing = /^  Property '(.+?)' is missing/.exec(referenceLines[index + 1])?.[1];
    return [{ row: Number(match[1]) - 1, source: match[2], target: match[3], detail: detail?.slice(1), missing }];
  });
  const execution = executeProgram('typescript', fs.readFileSync(fixture, 'utf8'));
  if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
  expect(execution.diagnostics.map((diagnostic) => diagnostic.row)).toEqual(
    expected.map((diagnostic) => diagnostic.row)
  );
  for (const [index, diagnostic] of execution.diagnostics.entries()) {
    const reported = /^型 '(.+?)' (?:を型|の引数を型|は制約) '(.+?)'/.exec(diagnostic.message);
    expect(reported?.slice(1)).toEqual([expected[index].source, expected[index].target]);
    const detail = /\n  型 '(.+?)' を型 '(.+?)'/.exec(diagnostic.message);
    expect(detail?.slice(1)).toEqual(expected[index].detail);
    expect(/\n  プロパティ '(.+?)' がありません。/.exec(diagnostic.message)?.[1]).toEqual(expected[index].missing);
  }
});

test('whole-tuple mismatches name the positional types reported by TypeScript', () => {
  const fixture = new URL('../fixtures/typescriptTypeErrors/rejects-tuple-element-offsets.ts.txt', import.meta.url);
  const reference = fs.readFileSync(
    new URL('../fixtures/typescriptTypeErrors/rejects-tuple-element-offsets.out', import.meta.url),
    'utf8'
  );
  const expected = [
    ...reference.matchAll(
      /^\((\d+),\d+\)[^\n]*\n  Type at position [^\n]*\n    Type '(.+?)' is not assignable to type '(.+?)'\./gm
    ),
  ];
  const diagnostics = diagnosticsOf(fs.readFileSync(fixture, 'utf8'));
  for (const [, row, source, target] of expected) {
    const diagnostic = diagnostics.find((message) => message.startsWith(`${row}: `));
    expect(diagnostic).toContain(`\n  型 '${source}' を型 '${target}' に代入することはできません。`);
  }
});

test('an optional object type reports the missing property of its non-nullish member', () => {
  const source = `interface Point { x: number; y: number }
const nullable: Point | null = { x: 1 };
const optional: Point | undefined = { x: 2 };`;
  const diagnostics = diagnosticsOf(source);
  expect(diagnostics).toHaveLength(2);
  for (const diagnostic of diagnostics) {
    expect(diagnostic).toContain("型 'Point' に代入");
    expect(diagnostic).toContain("プロパティ 'y' がありません");
  }
});

test.each(["'utf8'", "'utf-8'", "{ encoding: 'utf-8' }"])(
  'reads standard input and lists files with %s',
  (encoding) => {
    const source = `import * as fs from 'fs';\nconsole.log(fs.readFileSync(0, ${encoding}).trim(), fs.readdirSync('.', ${encoding}));`;
    expect(executeProgram('typescript', source, { stdin: 'hi\n', files: { 'a.txt': '' } })).toMatchObject({
      kind: 'executed',
      stdout: "hi [ 'a.txt' ]\n",
    });
  }
);

test('preserves ESM namespace interop, named default imports, and live named fs bindings', () => {
  const source = `"use strict";
import * as ns from 'fs';
import * as ns2 from 'fs';
import * as nodeNs from 'node:fs';
import fs, { default as fs2, existsSync } from 'fs';
import { default as nodeFs, existsSync as nodeExists } from 'node:fs';
const req = require('fs');
console.log(ns === req, ns === ns2, ns === nodeNs, (ns as any).default === req);
console.log(fs === req, fs2 === req, nodeFs === req, typeof (ns as any).default);
req.existsSync = function (this: unknown) {
  return [this === undefined, this === ns];
} as any;
console.log(existsSync('missing'), nodeExists('missing'), ns.existsSync('missing'));`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'false false false true\ntrue true true object\n[ true, false ] [ true, false ] [ false, true ]\n',
    uncaughtException: undefined,
  });
  expect(diagnosticsOf("import * as ns from 'fs'; (ns as any)['read' + 'File']('a', () => {});")).toEqual([
    '1: fs.readFile は、この採点環境では使えません。',
  ]);
});

test('resolves type-position import("fs") queries and type references while rejecting dynamic import()', () => {
  const source = `type FsModule = typeof import('fs');
const fs2: FsModule = require('fs') as typeof import('fs');
let p: import('fs').PathLike = 'a.txt';
const exists: typeof import('node:fs').existsSync = fs2.existsSync;
declare module 'custom-mod' {
  export interface Box<T> { value: T }
  export const version: number;
}
const boxed: import('custom-mod').Box<string> = { value: 'ok' };
const ver: typeof import('custom-mod').version = 1;
console.log(typeof exists, p, boxed.value, ver);`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout: 'function a.txt ok 1\n',
    uncaughtException: undefined,
  });
  expect(diagnosticsOf("const m = import('fs');")).toEqual(['1: import や export は、この採点環境では使えません。']);
  expect(diagnosticsOf("type Bad = typeof import('no-such');")).toEqual([
    "1: モジュール 'no-such' またはそれに対応する型宣言が見つかりません。",
  ]);
  expect(diagnosticsOf("type Bad = import('fs').NoSuch;")).toEqual([
    "1: 名前空間 '\"fs\"' にエクスポートされたメンバー 'NoSuch' がありません。",
  ]);
  expect(diagnosticsOf("type Bad = typeof import('fs').readFile;")).toEqual([
    '1: fs.readFile は、この採点環境では使えません。',
  ]);
  expect(diagnosticsOf("type Bad = import('fs').Stats;")).toEqual(['1: fs.Stats は、この採点環境では使えません。']);
});

test('rejects context.addInitializer after its decorator finishes', () => {
  const source = `const saved: ((fn: () => void) => void)[] = [];
function save(_value: any, ctx: DecoratorContext) {
  ctx.addInitializer(() => console.log('ok:' + String(ctx.name)));
  saved.push(ctx.addInitializer);
}
function checkPrev(_value: any, _ctx: DecoratorContext) {
  try {
    saved.at(-1)!(() => console.log('during-next'));
  } catch (e: any) {
    console.log('next:' + e.name + ':' + e.message);
  }
}
@save
class C {
  @checkPrev
  @save
  m() {}
  @save
  x = 1;
}
for (const add of saved) {
  try {
    add(() => console.log('late'));
  } catch (e: any) {
    console.log('after:' + e.name + ':' + e.message);
  }
}
new C();`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'executed',
    stdout:
      'next:TypeError:Already initialized\nok:C\nafter:TypeError:Already initialized\nafter:TypeError:Already initialized\nafter:TypeError:Already initialized\nok:m\nok:x\n',
    uncaughtException: undefined,
  });
});

test('validates namespace and module-top-level placement of this, return, exports, imports, and global augmentations', () => {
  expect(diagnosticsOf('namespace N { console.log(this); }')).toEqual([
    "1: 'this' はモジュール本体内または名前空間本体内では参照できません。",
  ]);
  expect(diagnosticsOf('namespace N { if (true) console.log(this); }')).toEqual([
    "1: 'this' はモジュール本体内または名前空間本体内では参照できません。",
  ]);
  expect(
    executeProgram(
      'typescript',
      'namespace N { export function f(this: number) { return this + 1; } } console.log(N.f.call(2));'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '3\n',
  });

  expect(diagnosticsOf('namespace N { return 5; } console.log(N);')).toEqual([
    "1: 'return' ステートメントは、関数本体でのみ使用できます。",
  ]);
  expect(diagnosticsOf('namespace N { if (true) { return; } }')).toEqual([
    "1: 'return' ステートメントは、関数本体でのみ使用できます。",
  ]);

  expect(diagnosticsOf('namespace N { const a = 1; export { a }; }')).toEqual([
    '1: エクスポート宣言は名前空間でサポートされません。',
  ]);
  expect(diagnosticsOf('namespace N { type T = number; export type { T }; }')).toEqual([
    '1: エクスポート宣言は名前空間でサポートされません。',
  ]);
  expect(diagnosticsOf('namespace N { export default 1; }')).toEqual([
    '1: 既定のエクスポートは、ECMAScript スタイルのモジュールでのみ使用できます。',
  ]);
  expect(
    executeProgram('typescript', 'declare namespace N { const a: number; export { a }; } console.log(1);')
  ).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
  });

  expect(diagnosticsOf('namespace N { import fs from "fs"; console.log(fs.existsSync("x")); }')).toEqual([
    '1: 名前空間内のインポート宣言は、モジュールを参照できません。',
  ]);
  expect(diagnosticsOf('if (true) { import { existsSync } from "fs"; console.log(existsSync("x")); }')).toEqual([
    '1: インポート宣言は、名前空間またはモジュールの最上位レベルでのみ使用できます。',
  ]);

  expect(
    diagnosticsOf(
      'export {};\nnamespace N { declare global { interface Array<T> { extra: number } } }\nconsole.log([1].extra);'
    )
  ).toEqual([
    '2: グローバルスコープの拡張は、外部モジュールかアンビエントモジュールの宣言の中に直接書くことしかできません。',
    "3: プロパティ 'extra' は型 'number[]' にありません。",
  ]);
  expect(
    diagnosticsOf(
      'export {};\nif (true) { declare global { interface Array<T> { extra: number } } }\nconsole.log([1].extra);'
    )
  ).toEqual([
    '2: アンビエント モジュール宣言は、ファイルの最上位にのみ使用できます。',
    "3: プロパティ 'extra' は型 'number[]' にありません。",
  ]);
  expect(
    executeProgram(
      'typescript',
      'declare module "custom-aug" { global { interface Array<T> { extra?: number } } }\nconst n: number | undefined = [1].extra;\nconsole.log(n);'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'undefined\n',
  });
});

test('lowers qualified fs import aliases, anonymous abstract default exports, declare-only namespaces, colliding decorated keys, and stream flags/paths', () => {
  expect(
    executeProgram(
      'typescript',
      "import * as fs from 'fs';\nimport fsDefault from 'fs';\nimport { default as nodeFs } from 'node:fs';\nimport exists = fs.existsSync;\nimport exists2 = fsDefault.existsSync;\nimport write = nodeFs.writeFileSync;\nimport P = fs.PathLike;\nconst p: P = 'f.txt';\nwrite(p, 'ok');\nconsole.log(exists('missing'), exists2('f.txt'));"
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'false true\n',
    uncaughtException: undefined,
  });

  expect(
    executeProgram(
      'typescript',
      "export default abstract class { abstract m(): void; static label = this.name; static { console.log(this.name, this.label); } }\nconsole.log('done');"
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'default default\ndone\n',
    uncaughtException: undefined,
  });

  expect(
    executeProgram(
      'typescript',
      'function d(v: any, c: any) { c.addInitializer(function(this: any) { console.log("init:" + this.name); }); console.log(JSON.stringify([v.name, c.name])); }\n@d export default abstract class { static { console.log("static:" + this.name); } }'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '["",""]\nstatic:default\ninit:\n',
    uncaughtException: undefined,
  });

  expect(
    executeProgram(
      'typescript',
      'function d(v: any, c: any) { console.log(JSON.stringify([v.name, c.name])); }\n@d export default class {}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '["",""]\n',
    uncaughtException: undefined,
  });

  expect(
    executeProgram(
      'typescript',
      'namespace N { declare function g(): void; }\nconsole.log(typeof N);\nnamespace N { export const x = 1; }\nconsole.log(N.x);\nnamespace A.B.C { declare const y: number; }\nconsole.log(typeof A, typeof A.B, typeof (A.B as any).C);'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'undefined\n1\nobject object undefined\n',
    uncaughtException: undefined,
  });

  expect(
    executeProgram(
      'typescript',
      'const key1: string = "m", key2: string = "m";\nfunction dec(value: any, _ctx: any) { console.log(value()); return () => 3; }\nclass X { @dec [key1]() { return 1; } [key2]() { return 2; } }\nconsole.log((new X() as any).m());'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '2\n3\n',
    uncaughtException: undefined,
  });

  expect(
    executeProgram(
      'typescript',
      `import fs from 'fs';
fs.writeFileSync('part', 'x');
const results: string[] = [];
for (const fn of [
  () => fs.writeFileSync('/dev/stdout', 'bad', { flag: 'wx' }),
  () => fs.appendFileSync('/dev/stderr', 'bad', { flag: 'ax' }),
  () => fs.writeFileSync('/dev/stdout', 'bad', { flag: 'nonsense' }),
  () => fs.readFileSync('/missing/../dev/stdin', 'utf8'),
  () => fs.writeFileSync('part/../dev/stdout', 'bad'),
  () => fs.writeFileSync(1, 'bad', { get flag(): string { throw new Error('stop1'); } }),
  () => fs.appendFileSync(2, 'bad', { get flag(): string { throw new Error('stop2'); } }),
]) {
  try { fn(); results.push('ok'); } catch (e: any) { results.push(e.code ?? (e.name === 'Error' ? e.message : e.name)); }
}
fs.writeFileSync(1, 'fd1:', { flag: 'nonsense' });
fs.appendFileSync(2, 'fd2', { flag: 'nonsense' });
console.log(fs.existsSync('/missing/../dev/stdin'), fs.existsSync('part/../dev/stdout'), results.join(','));`,
      { stdin: 'hi' }
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'fd1:false false EEXIST,EEXIST,TypeError,ENOENT,ENOTDIR,stop1,stop2\n',
    stderr: 'fd2',
    uncaughtException: undefined,
  });
});

test('enforces variance, thenable, import-query, optional-assertion, ambient-module, namespace-import, enum-key, and computed-this checks', () => {
  expect(diagnosticsOf('interface Box<in out T> {}\ninterface Outer<out T> { box: Box<T> }')).toEqual([
    "2: 分散の注釈が示すとおりには、型 'Outer<sub-T>' を型 'Outer<super-T>' に代入できません。",
  ]);
  expect(
    diagnosticsOf(
      'type Box<in out T> = {};\ntype Outer<out T> = { box: Box<T> };\nconst s: Box<string> = {};\nconst n: Box<number> = s;'
    )
  ).toEqual([
    "2: 分散の注釈が示すとおりには、型 'Outer<sub-T>' を型 'Outer<super-T>' に代入できません。",
    "4: 型 'Box<string>' を型 'Box<number>' に代入することはできません。",
  ]);
  expect(
    executeProgram(
      'typescript',
      'type Consumer<in T> = ((x: T) => void);\nconst f: Consumer<number> = (x) => console.log(x);\nf(1);'
    )
  ).toMatchObject({ kind: 'executed', stdout: '1\n' });

  expect(diagnosticsOf('async function f(v: { then?: (resolve: (n: number) => void) => void }) { await v; }')).toEqual([
    "1: 'await' オペランドの型は、有効な Promise であるか、呼び出し可能な 'then' メンバーを含んでいないかのどちらかであることが必要です。",
  ]);
  expect(
    diagnosticsOf(
      'class Loop { then(resolve: (v: Loop) => void) { resolve(this); } }\nasync function main() { await new Loop(); }'
    )
  ).toEqual(["2: 型は、それ自身の 'then' メソッドのフルフィルメント コールバック内で直接または間接的に参照されます。"]);

  expect(
    diagnosticsOf(
      "declare module 'custom' { export function id<T>(x: T): T; }\ntype Fn = typeof import('custom').id<string>;\nconst f: Fn = (x) => x;\nconst n: number = f('hello');"
    )
  ).toEqual(["4: 型 'string' を型 'number' に代入することはできません。"]);
  expect(diagnosticsOf("type Bad = typeof import('fs').readFile<string>;")).toEqual([
    '1: fs.readFile は、この採点環境では使えません。',
  ]);

  expect(
    diagnosticsOf(
      'function f(check: ((x: unknown) => asserts x is string) | undefined, value: unknown) { check?.(value); console.log(value.toUpperCase()); }'
    )
  ).toEqual(["1: 'value' の型は 'unknown' です。"]);

  expect(
    executeProgram(
      'typescript',
      "declare module 'custom' { export interface A { x: number } }\ndeclare module 'custom' { export interface B { y: number } }\nconst a: import('custom').A = { x: 1 };\nconst b: import('custom').B = { y: 2 };\nconsole.log(a.x, b.y);"
    )
  ).toMatchObject({ kind: 'executed', stdout: '1 2\n' });

  expect(diagnosticsOf("declare namespace N { console.log('hidden'); }")).toEqual([
    '1: ステートメントは環境コンテキストでは使用できません。',
  ]);

  expect(diagnosticsOf("import * as fs from 'fs'; fs.existsSync = () => true;")).toEqual([
    '1: existsSync は読み取り専用のプロパティなので、代入できません。',
  ]);
  expect(diagnosticsOf("import * as fs from 'node:fs'; fs['existsSync'] = () => true;")).toEqual([
    '1: existsSync は読み取り専用のプロパティなので、代入できません。',
  ]);

  expect(diagnosticsOf('namespace M { export var v = 1; var v = 2; }')).toEqual([
    "1: マージされた宣言 'v' の個々の宣言はすべてエクスポートされるか、すべてローカルであるかのどちらかである必要があります。",
    "1: マージされた宣言 'v' の個々の宣言はすべてエクスポートされるか、すべてローカルであるかのどちらかである必要があります。",
  ]);

  expect(
    executeProgram(
      'typescript',
      'function* inner() { return Promise.resolve(3); }\nasync function* outer() { const n: number = yield* inner(); console.log(n.toFixed(1)); }\nouter().next();'
    )
  ).toMatchObject({ kind: 'executed', stdout: '3.0\n' });

  expect(executeProgram('typescript', 'process.exitCode = null;\nconsole.log(process.exitCode);')).toMatchObject({
    kind: 'executed',
    stdout: 'undefined\n',
  });

  expect(
    executeProgram(
      'typescript',
      "const f = () => 3;\nenum Level { Low = 1, High = f() }\nconst labels: Record<Level, string> = { [Level.Low]: 'low', [Level.High]: 'high' };\nconsole.log(labels[Level.High]);"
    )
  ).toMatchObject({ kind: 'executed', stdout: 'high\n' });

  expect(diagnosticsOf('function f(this: { key: string }) { return class C { [this.key]() { return 1; } }; }')).toEqual(
    ["1: 'this' は、計算されたプロパティ名では参照できません。"]
  );
  expect(
    executeProgram(
      'typescript',
      "function f(this: { key: string }) { return { [this.key]() { return 7; } }; }\nconsole.log((f.call({ key: 'm' }) as any).m());"
    )
  ).toMatchObject({ kind: 'executed', stdout: '7\n' });

  const descriptorCollision = executeProgram(
    'typescript',
    "const a: string = 'x', b: string = 'x';\nfunction first(v: any) { console.log('first', typeof v); return v; }\nfunction second(v: any) { console.log('second', typeof v); return () => 3; }\nclass C { @first @second [a]() { return 1; } get [b]() { return 2; } }"
  );
  expect(descriptorCollision).toMatchObject({
    kind: 'executed',
    stdout: 'second undefined\nfirst function\n',
  });
  expect(descriptorCollision.kind === 'executed' ? descriptorCollision.uncaughtException : '').toContain(
    'TypeError: Invalid property descriptor'
  );

  expect(
    diagnosticsOf(
      "export {};\nnamespace N { declare module 'custom' { global { interface Array<T> { extra: number } } } }\nconsole.log([1].extra);"
    )
  ).toEqual([
    '2: アンビエント モジュールを、他のモジュールまたは名前空間内の入れ子にすることはできません。',
    '2: グローバルスコープの拡張は、外部モジュールかアンビエントモジュールの宣言の中に直接書くことしかできません。',
    "3: プロパティ 'extra' は型 'number[]' にありません。",
  ]);
});
