import { executeProgram } from '../../src/interpreter/program';

const cases = [
  ...[1, 100].flatMap((methods) =>
    [true, false].map((defaults) => ({
      declarations: methodDeclarations(methods, defaults),
      name: `${methods}/${defaults}`,
    }))
  ),
  { declarations: superclassDeclarations(30), name: 'superclasses' },
];
const results = cases.map(({ declarations, name }) => {
  const infinite = `${declarations}
f::C a=>a->IO ()
f x=m0 x \`seq\` f [x]
main=f(0::Int)`;
  const finite = `${declarations}
f::C a=>Int->a->IO ()
f 0 _=print(1::Int)
f n x=m0 x \`seq\` f (n-1) [x]
main=f 5 (0::Int)`;
  return { name, finite: executeProgram('haskell', finite), infinite: executeProgram('haskell', infinite) };
});
process.stdout.write(JSON.stringify(results));

function methodDeclarations(count: number, defaults: boolean): string {
  const signatures = Array.from({ length: count }, (_, index) => ` m${index}::a->Int`).join('\n');
  const methods = Array.from({ length: count }, (_, index) => ` m${index} _=0`).join('\n');
  return defaults
    ? `class C a where\n${signatures}\n${methods}\ninstance C Int\ninstance C a=>C [a]`
    : `class C a where\n${signatures}\ninstance C Int where\n${methods}\ninstance C a=>C [a] where\n${methods}`;
}

function superclassDeclarations(count: number): string {
  const parents = Array.from({ length: count }, (_, index) => `S${index} a`).join(',');
  const supers = Array.from(
    { length: count },
    (_, index) => `class S${index} a\ninstance S${index} Int\ninstance S${index} a=>S${index} [a]`
  ).join('\n');
  return `${supers}\nclass (${parents})=>C a where\n m0::a->Int\n m0 _=0\ninstance C Int\ninstance (${parents})=>C [a]`;
}
