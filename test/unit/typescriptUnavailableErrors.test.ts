import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test.each([
  'Array.fromAsync([1]);',
  'const list: any = []; list.constructor.fromAsync(list);',
  'const fromAsync = Object.getOwnPropertyDescriptor(Array, "fromAsync")!.value; fromAsync.call(Array, [1]);',
  'const fromAsync = Array.fromAsync.bind(Array); fromAsync([1]);',
])('Array.fromAsync stays unavailable through %s', (source) => {
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: 'Array.fromAsync は、この採点環境では使えません。' }],
  });
});

test.each([
  ['toPrimitive', 'console.log(Symbol.toPrimitive);'],
  ['species', 'const species = Array[Symbol.species]; console.log(species);'],
  ['hasInstance', 'console.log(Symbol["hasInstance"]);'],
  ['toStringTag', 'const constructor: any = Symbol; console.log(constructor[["toString", "Tag"].join("")]);'],
  ['species', 'console.log(Object.getOwnPropertyDescriptor(Symbol, "species")?.value);'],
])('reports an unavailable Symbol.%s without cascading errors', (name, source) => {
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: `Symbol.${name} などの well-known シンボルは、この採点環境では使えません。` }],
  });
});

test('a later console argument cannot hide an earlier function-to-string conversion', () => {
  const source = 'let value: number | (() => void) = () => {}; console.log("%s", value, value = 1);';
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: '関数やクラスの文字列への変換は、この採点環境では使えません。' }],
  });
});

test.each([
  ['() => void', 'return `${value}`;'],
  ['() => void', 'return String(value);'],
  ['{ tag: number } & (() => void)', 'return "prefix" + value;'],
  ['(() => void) | string', 'console.log("%s", value);'],
  ['() => void', 'return value.toString();'],
  ['new () => { value: number }', 'return String(value);'],
])('checks generic function source conversion with %s in %s', (bound, conversion) => {
  const source = `function show<T extends ${bound}>(value: T) {
  ${conversion}
}
console.log("done");`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: '関数やクラスの文字列への変換は、この採点環境では使えません。' }],
  });
});

test.each([
  'function show(value: () => void) { return String.raw`value=${value}`; }',
  'class Example {} function show() { return String.raw`value=${Example}`; }',
  'function show<T extends (() => void) | string>(value: T) { return String["raw"]`value=${value}`; }',
])('checks known source conversions in unused String.raw templates: %s', (source) => {
  expect(executeProgram('typescript', source + '\nconsole.log("done");')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: '関数やクラスの文字列への変換は、この採点環境では使えません。' }],
  });
});

test('checks dynamically typed String.raw substitutions at runtime', () => {
  const source = 'function show(value: any) { return String.raw`value=${value}`; } show(() => {});';
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: '関数やクラスの文字列への変換は、この採点環境では使えません。' }],
  });
});

test('generic source conversions allow unknown values and ordinary object string methods', () => {
  const source = `function show<T>(value: T) { return String(value); }
function method<T extends { toString(): string }>(value: T) { return value.toString(); }
console.log(show("text"), method({ toString() { return "object"; } }));`;
  expect(executeProgram('typescript', source)).toMatchObject({ kind: 'executed', stdout: 'text object\n' });
});

test.each([
  'const { toString: method } = fn; method.call(fn);',
  'const { toString: method } = fn; const key = "call"; method[key](fn);',
  'const { toString: method } = fn; const alias = method; const next = alias; next.call(fn);',
  'const { toString: method } = fn; let alias: () => string; alias = method; alias.call(fn);',
  'function neverCalled() { let key: "name" | "call" = "name"; const method = fn.toString; key = "call"; method[key](fn); }',
  'function neverBound() { const method = fn.toString; const bound = method.bind(fn); return bound(); }',
  'function neverComputed() { const key = "apply"; const method = fn.toString; return method[key](fn, []); }',
  'const [{ toString: method }] = [fn]; const escaped = { method }; escaped.method.call(fn);',
  'function use(method: () => string) { var method: () => string = fn.toString; arguments[0].call(fn); } use(() => "");',
  'const { toString: method } = fn; type Method = typeof method; (method as Method).call(fn);',
])('rejects function source conversion through %s', (use) => {
  const source = `function fn() {} ${use}`;
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: '関数やクラスの文字列への変換は、この採点環境では使えません。' }],
  });
});

const caughtFunctionError = `'use strict';
const fn=()=>{};
Object.freeze(fn);
let caught:any;
try { (fn as any).name='changed'; } catch(error) { caught=error; }
`;

test.each([
  "Object.defineProperty(caught,'message',{value:'replacement'});",
  "Object.defineProperty(caught,'message',{get:()=> 'replacement'});",
])('a caught function-property error allows redefining its message: %s', (definition) => {
  expect(executeProgram('typescript', caughtFunctionError + definition + 'console.log(caught.message);')).toMatchObject(
    {
      kind: 'executed',
      stdout: 'replacement\n',
      uncaughtException: undefined,
    }
  );
});

test.each([
  "const F=Function; try { F('return 1'); } catch { console.log('caught'); }",
  "const F:any=Function; try { new F('return 1'); } catch { console.log('caught'); }",
  "const F:any=(()=>1).constructor; try { F('return 1'); } catch { console.log('caught'); }",
  "const F:any=(()=>1).constructor; try { new F('return 1'); } catch { console.log('caught'); }",
  "const F=Function.bind(undefined); try { F('return 1'); } catch { console.log('caught'); }",
  "const F:any=Function.bind(undefined); try { new F('return 1'); } catch { console.log('caught'); }",
  "const F=Function; try { F.call(undefined,'return 1'); } catch { console.log('caught'); }",
])('Function constructor aliases remain unavailable rather than catchable: %s', (source) => {
  const result = executeProgram('typescript', source);
  expect(result).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('Function コンストラクタ') }],
  });
});

test.each([
  ["(fn as any).name='changed'", "Cannot assign to read only property 'name' of function '()=>{}'"],
  ['delete (fn as any).name', "Cannot delete property 'name' of ()=>{}"],
  ['Object.setPrototypeOf(fn, null)', '()=>{} is not extensible'],
  ['(fn as any).__proto__ = null', '()=>{} is not extensible'],
])('a trace can keep and log a caught function-property error: %s', (action, message) => {
  const source = caughtFunctionError.replace("(fn as any).name='changed'", action);
  const program = source + 'const handled = caught instanceof TypeError; console.log(handled, caught.message);';
  expect(traceProgram('typescript', program, program)).toMatchObject({
    stdout: `true ${message}\n`,
    finalVars: { handled: true },
    uncaughtException: undefined,
  });
});

test('tracing a handled function-property error without retaining its message records the result', () => {
  const source = `'use strict';const f=()=>{};Object.freeze(f);let handled=0;try{(f as any).name='x';}catch{handled++;}console.log(handled);`;
  const recording = traceProgram('typescript', source, source);
  expect(recording.stdout).toBe('1\n');
  expect(recording.finalVars.handled).toBe(1);
});

test.each([
  'const f: any = Math.abs; console.log(f.toString());',
  'const f: any = Math.abs.bind(null); console.log(String(f));',
  'const f: any = Math.abs.bind(null); console.log(`${f}`);',
  'const f: any = Math.abs; console.log("%s", f);',
])('native and bound function source conversions remain unavailable: %s', (source) => {
  expect(executeProgram('typescript', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('関数やクラスの文字列への変換') }],
  });
});

test.each([
  ['type Box<in out T>={value:T};const a:Box<string>={value:"hi"};const b:Box<string|number>=a;', 'compileError'],
  ['type Getter<in T>=()=>T;', 'compileError'],
  ['interface Producer<out T>{readonly value:T}const p:Producer<number>={value:1};', 'executed'],
  ['class Consumer<in T>{accept(value:T){}}new Consumer<number>().accept(1);', 'executed'],
])('variance annotations are checked as tsc checks them: %s', (source, kind) => {
  expect(executeProgram('typescript', source)).toMatchObject({ kind });
});

test.each([
  ["const path = require('path');", "モジュール 'path' の require は、この採点環境では使えません。"],
  ["const fs = require('fs', 'utf8');", '引数は 1 個必要ですが、2 個渡されています。'],
  ['const fs = require(1);', "型 'number' の引数を型 'string' のパラメーターに渡すことはできません。"],
  [
    "const fs = require('fs'); fs.readdirSync('.', { recursive: true });",
    'readdirSync の recursive は、この採点環境では使えません。',
  ],
  ["let id = 'fs'; const fs = require(id);", '名前が定数で決まらない require は、この採点環境では使えません。'],
  ["const fs = require('fs'); fs.statSync('.');", 'fs.statSync は、この採点環境では使えません。'],
  ["const load = require; load('path');", '呼び出し以外での require は、この採点環境では使えません。'],
  ["require.call(null, 'path');", 'require.call は、この採点環境では使えません。'],
  ["const { readFile } = require('fs');", 'fs.readFile は、この採点環境では使えません。'],
  ["import { readFile } from 'fs';", 'fs.readFile は、この採点環境では使えません。'],
  ['const { cwd } = process;', 'process.cwd は、この採点環境では使えません。'],
  [
    "const fs = require('fs'); fs.readFileSync('x', null);",
    'エンコーディングを指定しない readFileSync（Buffer）は、この採点環境では使えません。',
  ],
  [
    "const fs = require('fs'); fs.readFileSync('x', { flag: 'r' });",
    'エンコーディングを指定しない readFileSync（Buffer）は、この採点環境では使えません。',
  ],
  ["import * as fs from 'fs'; fs.readFile('x', () => {});", 'fs.readFile は、この採点環境では使えません。'],
  ['console.log(process.cwd());', 'process.cwd は、この採点環境では使えません。'],
  ['console.log(process.stdout.columns);', 'process.stdout.columns は、この採点環境では使えません。'],
])('rejects a Node.js feature the interpreter lacks before running %s', (source, message) => {
  expect(executeProgram('typescript', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ message }] });
});

test('suggests the member a misspelled name of a Node.js object means, as tsc does', () => {
  expect(executeProgram('typescript', 'console.log(process.stdout.writ);')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: "プロパティ 'writ' は型 'WriteStream' にありません。'write' のことですか？" }],
  });
});
