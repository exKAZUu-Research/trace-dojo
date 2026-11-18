import { expect, test } from 'vitest';

import { CompileError } from '../../src/interpreter/diagnostics';
import { executeProgram, traceProgram } from '../../src/interpreter/program';

const caughtFunctionError = `'use strict';
const fn=()=>{};
Object.freeze(fn);
let caught:any;
try { (fn as any).name='changed'; } catch(error) { caught=error; }
`;

test.each([
  'console.log(caught.message);',
  "console.log(Object.getOwnPropertyDescriptor(caught,'message')?.value);",
  'console.log(caught);',
  'console.dir(caught,{showHidden:true});',
  "Object.defineProperty(caught,'message',{enumerable:true}); console.table([caught]);",
  "Object.defineProperty(caught,'message',{enumerable:true}); JSON.stringify(caught);",
  'Object.freeze(caught); console.log(caught.message);',
  "Object.defineProperty(caught,'message',{writable:false}); console.log(caught.message);",
])('observing an unavailable function-source error message stops the program: %s', (observation) => {
  const result = executeProgram('typescript', caughtFunctionError + observation);
  expect(result).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('関数やクラスの文字列への変換') }],
  });
});

test.each([
  "Object.defineProperty(caught,'message',{value:'replacement'});",
  "Object.defineProperty(caught,'message',{get:()=> 'replacement'});",
])('explicitly redefining an unavailable message replaces it: %s', (definition) => {
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

test('tracing never exposes an internal marker as an error message', () => {
  expect(() => traceProgram('typescript', caughtFunctionError, caughtFunctionError)).toThrow(CompileError);
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
