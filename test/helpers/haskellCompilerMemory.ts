import { executeProgram, traceProgram } from '../../src/interpreter/program';

executeProgram('haskell', 'main=print(1::Int)');
const baseline = process.resourceUsage().maxRSS;
const tracing = process.argv[2] === 'trace';
const branches = Number(process.argv[3] ?? 2);
const count = tracing ? (branches === 2 ? 20 : 12) : 22;
const nested = `${'f ('.repeat(count)}${tracing ? 'x' : 'True'}${')'.repeat(count)}`;
let source = tracing
  ? `f x=(${Array.from({ length: branches }, () => 'x').join(',')})\ng x=${nested}\nmain=do\n  let y=g True\n  print(1::Int)`
  : `f x=(x,x)\ny=${nested}\nmain=print(1::Int)`;
if (process.argv[2] === 'classes') {
  const count = 28;
  const declarations = [
    'class Eq a=>C0 a',
    'class C0 a=>C1 a',
    ...Array.from({ length: count - 1 }, (_, offset) => {
      const index = offset + 2;
      return `class (C${index - 1} a,C${index - 2} a)=>C${index} a`;
    }),
  ];
  source = `${declarations.join('\n')}\nf::C${count} a=>a->Bool\nf x=x==x\nmain=print(1::Int)`;
}
const result = tracing ? traceProgram('haskell', source, source) : executeProgram('haskell', source);
process.stdout.write(
  JSON.stringify({
    ...('kind' in result ? { kind: result.kind } : { traceItemCount: result.traceItems.length }),
    stdout: 'stdout' in result ? result.stdout : undefined,
    peakRatio: process.resourceUsage().maxRSS / baseline,
  })
);
