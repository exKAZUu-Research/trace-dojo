import { executeProgram } from '../../src/interpreter/program';

const count = 10_000;
const chain = Array.from({ length: count }, (_, index) => `type A${index}=A${index + 1}`).join('\n');
const sources = [
  `${chain}\ntype A${count}=Int\nmain=print(1::Int)`,
  `${chain}\ntype A${count}=A0\nmain=print(1::Int)`,
  'type A=B -> C\ntype B=C\ntype C=Int\nmain=print((id::A) 1)',
  'type A a=B a\ntype B a=C a -> a\ntype C a=A a\nmain=print(1::Int)',
];
process.stdout.write(JSON.stringify(sources.map((source) => executeProgram('haskell', source))));
