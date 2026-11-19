import { executeProgram } from '../../src/interpreter/program';

const dictionaries = [
  ...[1, 100].flatMap((methods) =>
    [true, false].map((defaults) => ({
      declarations: methodDeclarations(methods, defaults),
      name: `${methods}/${defaults}`,
    }))
  ),
  { declarations: superclassDeclarations(30), name: 'superclasses' },
];
const dictionaryCases = dictionaries.map(({ declarations, name }) => {
  const infinite = `${declarations}
f::C a=>a->IO ()
f x=m0 x \`seq\` f [x]
main=f(0::Int)`;
  const finite = `${declarations}
f::C a=>Int->a->IO ()
f 0 _=print(1::Int)
f n x=m0 x \`seq\` f (n-1) [x]
main=f 5 (0::Int)`;
  return { name, finite, infinite };
});
const constructorCases = [1, 4, 8, 9, 16, 100, 150].map((size) => {
  const declaration = 'data W=W ' + Array.from({ length: size }, () => 'W').join(' ');
  const fields = Array.from({ length: size }, () => 'x').join(' ');
  return {
    name: `constructor/${size}`,
    infinite: `${declaration}\nf::W->IO ()\nf x=let y=W ${fields} in y \`seq\` f y\nmain=f undefined`,
    finite: `${declaration}\nf::Int->W->IO ()\nf 0 _=print(1::Int)\nf n x=let y=W ${fields} in y \`seq\` f (n-1) y\nmain=f 5 undefined`,
  };
});
const environmentCases = [1, 1000].map((size) => {
  const bindings = Array.from({ length: size }, (_, index) => `y${index}=x`).join(';');
  return {
    name: `environment/${size}`,
    infinite: `f::()->IO ()\nf x=let {${bindings}} in f(id y0)\nmain=f ()`,
    finite: `f::Int->()->IO ()\nf 0 _=print(1::Int)\nf n x=let {${bindings}} in f(n-1)(id y0)\nmain=f 5 ()`,
  };
});
const partialCases = [...[1, 8, 9, 240].map((size) => ({ size, extended: false })), { size: 240, extended: true }].map(
  ({ size, extended }) => {
    const parameters = Array.from({ length: size }, (_, index) => `a${index}`).join(' ');
    const values = Array.from({ length: size }, () => 'x');
    const first = extended ? Math.floor(size / 2) : size;
    const bindings = `p=(\\${parameters} z->()) ${values.slice(0, first).join(' ')}; y=p ${values.slice(first).join(' ')}`;
    return {
      name: `partial/${size}/${extended}`,
      infinite: `f::a->IO ()\nf x=let {${bindings}} in y \`seq\` f y\nmain=f ()`,
      finite: `f::Int->a->IO ()\nf 0 _=print(1::Int)\nf n x=let {${bindings}} in y \`seq\` f(n-1)y\nmain=f 5 ()`,
    };
  }
);
const results = [...dictionaryCases, ...constructorCases, ...environmentCases, ...partialCases].map(
  ({ name, finite, infinite }) => ({
    name,
    finite: executeProgram('haskell', finite),
    infinite: executeProgram('haskell', infinite),
  })
);
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
