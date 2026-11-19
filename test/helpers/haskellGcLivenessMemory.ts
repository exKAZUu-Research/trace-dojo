import { traceProgram } from '../../src/interpreter/program';
import type { TraceItemVariable } from '../../src/problems/trace';

interface TraceSummary {
  name: string;
  stdout: string;
  steps: number;
  turtles: number;
  variables: number;
  first: TraceItemVariable[string] | undefined;
  last: TraceItemVariable[string] | undefined;
}

const repeatCount = 9000;
const variableCount = 6000;

process.stdout.write(
  JSON.stringify([recordRepeated('right', '右を向く'), recordRepeated('left', 'turnLeft'), recordDistinct()])
);

function recordRepeated(name: string, operation: string): TraceSummary {
  const statements = Array.from({ length: repeatCount }, () => ` ${operation} t`).join('\n');
  const source = `main=do
 t<-newTurtle
 if True then do
  print(0::Int)
  else pure()
${statements}`;
  return record(name, source);
}

function recordDistinct(): TraceSummary {
  const bindings = Array.from({ length: variableCount }, (_, index) => `x${index}=1::Int`).join(';');
  const functions = Array.from({ length: variableCount }, (_, index) => ` let f${index} ()=x${index}`).join('\n');
  const source = `main=do
 t<-newTurtle
 let {${bindings}}
 if True then do
  print(0::Int)
  else pure()
${functions}
 print(f0(),f${variableCount - 1}())
 turnRight t`;
  return record('distinct', source);
}

function record(name: string, source: string): TraceSummary {
  const result = traceProgram('haskell', source, source);
  return {
    name,
    stdout: result.stdout,
    steps: result.traceItems.length,
    turtles: result.finalTurtles.length,
    variables: Object.keys(result.finalVars).length,
    first: result.finalVars.x0,
    last: result.finalVars[`x${variableCount - 1}`],
  };
}
