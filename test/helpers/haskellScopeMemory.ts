import { executeProgram, traceProgram } from '../../src/interpreter/program';

const count = 4000;
const statements = Array.from({ length: count }, (_, index) => ` x${index}<-return (1::Int)`).join('\n');
const source = `main=do -- atomic\n t<-newTurtle\n${statements}\n print x0`;
const execution = executeProgram('haskell', source);
const recording = traceProgram('haskell', source, source);
process.stdout.write(
  JSON.stringify({
    execution,
    recording: {
      stdout: recording.stdout,
      turtles: recording.finalTurtles.length,
      first: recording.finalVars.x0,
      last: recording.finalVars[`x${count - 1}`],
      count: Object.keys(recording.finalVars).length,
    },
  })
);
