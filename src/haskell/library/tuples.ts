/** GHC defines `Eq`, `Ord`, `Show`, `Read`, and `Bounded` for tuples of up to 15 elements. */
const MAX_INSTANCE_TUPLE = 15;

function tuple(names: string[]): string {
  return `(${names.join(', ')})`;
}

function tupleSource(size: number): string {
  const vars = Array.from({ length: size }, (_, index) => `a${index + 1}`);
  const others = Array.from({ length: size }, (_, index) => `b${index + 1}`);
  const context = (cls: string): string => `(${vars.map((name) => `${cls} ${name}`).join(', ')})`;
  const type = tuple(vars);
  const eq = vars.map((name, index) => `${name} == ${others[index]}`).join(' && ');
  let compare = `compare ${vars[size - 1]} ${others[size - 1]}`;
  for (let index = size - 2; index >= 0; index--)
    compare = `thenCmp (compare ${vars[index]} ${others[index]}) (${compare})`;
  const shown = vars.map((name) => `shows ${name}`).join(" . showChar ',' . ");
  const read = [
    '("(", s0) <- lex r',
    ...vars.flatMap((name, index) => [
      ...(index > 0 ? [`(",", c${index}) <- lex t${index}`] : []),
      `(${name}, t${index + 1}) <- reads ${index === 0 ? 's0' : `c${index}`}`,
    ]),
    `(")", u) <- lex t${size}`,
  ].join(', ');
  return [
    `instance ${context('Eq')} => Eq ${type} where`,
    `  ${tuple(vars)} == ${tuple(others)} = ${eq}`,
    `instance ${context('Ord')} => Ord ${type} where`,
    `  compare ${tuple(vars)} ${tuple(others)} = ${compare}`,
    `instance ${context('Show')} => Show ${type} where`,
    `  showsPrec _ ${tuple(vars)} = showChar '(' . ${shown} . showChar ')'`,
    `instance ${context('Read')} => Read ${type} where`,
    `  readsPrec _ = readParen False (\\r -> [(${tuple(vars)}, u) | ${read}])`,
    `instance ${context('Bounded')} => Bounded ${type} where`,
    `  minBound = ${tuple(vars.map(() => 'minBound'))}`,
    `  maxBound = ${tuple(vars.map(() => 'maxBound'))}`,
    '',
  ].join('\n');
}

export const BASE_TUPLES = Array.from({ length: MAX_INSTANCE_TUPLE - 1 }, (_, index) => tupleSource(index + 2)).join(
  '\n'
);
