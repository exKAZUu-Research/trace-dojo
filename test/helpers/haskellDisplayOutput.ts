import assert from 'node:assert/strict';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Variables } from '../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/Variables';
import { traceProgram } from '../../src/interpreter/program';

const scenarios = [
  { name: 'small', arity: 3, depth: 8, binding: '' },
  { name: 'binary', arity: 2, depth: 19, binding: '' },
  { name: 'ternary18', arity: 3, depth: 18, binding: '' },
  { name: 'ternary19', arity: 3, depth: 19, binding: '' },
  {
    name: 'forest',
    arity: 3,
    depth: 8,
    binding: `let {${Array.from({ length: 20 }, (_, i) => `alias${i}=x`).join(';')}}`,
  },
  { name: 'tuple', arity: 3, depth: 19, binding: 'let wrapped=(x,x)' },
  { name: 'list', arity: 3, depth: 19, binding: 'let wrapped=[x,x]' },
  { name: 'map', arity: 3, depth: 19, binding: 'let wrapped=M.singleton(1::Int)x' },
  { name: 'laterCheap', arity: 3, depth: 19, binding: 'let cheap=(1::Int,2::Int)' },
];

const results = scenarios.map(({ name, arity, depth, binding }) => {
  const source = `import qualified Data.Map as M
data T=Leaf|T ${Array.from({ length: arity }, () => 'T').join(' ')}
grow x=T ${Array.from({ length: arity }, () => 'x').join(' ')}
main=do
 let x=iterate grow Leaf !! ${depth}
 ${binding}
 print(1::Int)
 print(2::Int)`;
  const result = traceProgram('haskell', source, source);
  const last = result.traceItems.at(-1);
  assert.ok(last);
  assert.equal(result.uncaughtException, undefined);
  assert.equal(result.stdout, '1\n2\n');
  const references = last.referenceVars ?? {};
  const serialized = JSON.stringify(references);
  const html = renderToStaticMarkup(createElement(Variables, { traceItemVars: last.vars, referenceVars: references }));
  return {
    name,
    stdout: result.stdout,
    names: Object.keys(references),
    bytes: Buffer.byteLength(serialized),
    leaves: serialized.match(/"value":"Leaf"/gu)?.length ?? 0,
    truncated: serialized.includes('"value":"…"'),
    renderedTruncation: html.includes('…'),
    htmlLength: html.length,
    cheap: references.cheap,
  };
});

process.stdout.write(JSON.stringify(results));
