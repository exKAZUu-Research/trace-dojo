import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const diagnosticsOf = (source: string): string[] => {
  const execution = executeProgram('typescript', source);
  if (execution.kind !== 'compileError') throw new Error(`not rejected: ${JSON.stringify(execution)}`);
  return execution.diagnostics.map((diagnostic) => `${diagnostic.row + 1}: ${diagnostic.message}`);
};

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
  ['a Promise', 'Promise.resolve(1);', 'Promise は、この採点環境では使えません。'],
  ['a timer', 'setTimeout(() => {}, 1);', 'setTimeout などのタイマーは、この採点環境では使えません。'],
  ['a Date', 'new Date();', 'Date（日付と時刻）は、この採点環境では使えません。'],
  ['Math.random', 'Math.random();', 'Math.random は、この採点環境では使えません。'],
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
console.log(add, add.name, '%d', typeof A);`;
  expect(diagnosticsOf(source)).toEqual(
    [3, 4, 5, 6, 7, 9].map((row) => `${row}: 関数やクラスの文字列への変換は、この採点環境では使えません。`)
  );
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
const name: string | undefined = undefined;
console.log(name.length);`)
  ).toEqual([
    "2: 型 'string' を型 'number' に代入することはできません。",
    "4: 'name' は 'undefined' の可能性があります。",
  ]);
});

test.each([
  ['an infinite loop', 'while (true) {}', { kind: 'limitExceeded', limit: 'operations' }],
  ['endless output', "for (;;) console.log('x'.repeat(1000));", { kind: 'limitExceeded', limit: 'output' }],
])('%s stops at the execution limits', (_, source, expected) => {
  expect(executeProgram('typescript', source)).toEqual(expected);
});

test('type checking stops at the execution limits, as the server checks programs in its own process', () => {
  const heavyTypes = Array.from(
    { length: 8 },
    (_, index) => `type D${index} = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type M${index} = { [K in \`\${D${index}}\${D${index}}\${D${index}}\${D${index}}\`]: K };
const m${index}: Partial<M${index}> = {};`
  ).join('\n');
  expect(executeProgram('typescript', heavyTypes)).toMatchObject({ kind: 'limitExceeded' });
});

test('nested loops are checked once per loop, not once per pass of every enclosing loop', () => {
  const depth = 40;
  const loops = Array.from({ length: depth }, (_, index) => `for (let i${index} = 0; i${index} < 1; i${index}++) {`);
  const source = `let x: number | string = 1;\n${loops.join('\n')}\nx = x === 1 ? "a" : 1;\n${'}'.repeat(depth)}\nconsole.log(x);`;
  expect(executeProgram('typescript', source)).toMatchObject({ kind: 'executed', stdout: 'a\n' });
});
