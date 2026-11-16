import { executeProgram } from '../../src/interpreter/program';

executeProgram('haskell', 'main=print(1::Int)');
const baseline = process.resourceUsage().maxRSS;
const source = `f x=(x,x)\ny=${'f ('.repeat(22)}True${')'.repeat(22)}\nmain=print(1::Int)`;
const result = executeProgram('haskell', source);
process.stdout.write(
  JSON.stringify({
    kind: result.kind,
    stdout: result.kind === 'executed' ? result.stdout : undefined,
    peakRatio: process.resourceUsage().maxRSS / baseline,
  })
);
