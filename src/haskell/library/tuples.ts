const MAX_INSTANCE_TUPLE = 15;
const MAX_FUNCTOR_TUPLE = 7;
const MAX_SEMIGROUP_TUPLE = 5;
const MAX_MONAD_TUPLE = 4;

function tupleSource(size: number): string {
  const vars = Array.from({ length: size }, (_, index) => `a${index + 1}`);
  const others = Array.from({ length: size }, (_, index) => `b${index + 1}`);
  const type = tuple(vars);
  const eq = vars.map((name, index) => `${name} == ${others[index]}`).join(' && ');
  let compare = `compare ${vars[size - 1]} ${others[size - 1]}`;
  for (let index = size - 2; index >= 0; index--)
    compare = `thenCmp (compare ${vars[index]} ${others[index]}) (${compare})`;
  let less = `${vars[size - 1]} < ${others[size - 1]}`;
  for (let index = size - 2; index >= 0; index--) less = `thenLess (compare ${vars[index]} ${others[index]}) (${less})`;
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
    `instance ${tupleContext('Eq', vars)} => Eq ${type} where`,
    `  ${tuple(vars)} == ${tuple(others)} = ${eq}`,
    `instance ${tupleContext('Ord', vars)} => Ord ${type} where`,
    `  compare ${tuple(vars)} ${tuple(others)} = ${compare}`,
    `  ${tuple(vars)} < ${tuple(others)} = ${less}`,
    size === 2 ? '  x <= y = x `seq` not (y < x)' : '  x <= y = not (y < x)',
    '  x > y = y < x',
    '  x >= y = not (x < y)',
    `instance ${tupleContext('Show', vars)} => Show ${type} where`,
    `  showsPrec _ ${tuple(vars)} = showChar '(' . ${shown} . showChar ')'`,
    `instance ${tupleContext('Read', vars)} => Read ${type} where`,
    `  readsPrec _ = readParen False (\\r -> [(${tuple(vars)}, u) | ${read}])`,
    `instance ${tupleContext('Bounded', vars)} => Bounded ${type} where`,
    `  minBound = ${tuple(vars.map(() => 'minBound'))}`,
    `  maxBound = ${tuple(vars.map(() => 'maxBound'))}`,
    ...tupleAlgebra(vars, others),
    ...tupleFunctor(vars, others),
    '',
  ].join('\n');
}

function tupleAlgebra(vars: string[], others: string[]): string[] {
  if (vars.length > MAX_SEMIGROUP_TUPLE) return [];
  return [
    `instance ${tupleContext('Semigroup', vars)} => Semigroup ${tuple(vars)} where`,
    `  ${tuple(vars)} <> ${tuple(others)} = ${tuple(vars.map((value, index) => `${value} <> ${others[index]}`))}`,
    `  stimes n ${tuple(vars)} = ${tuple(vars.map((value) => `stimes n ${value}`))}`,
    `instance ${tupleContext('Monoid', vars)} => Monoid ${tuple(vars)} where`,
    `  mempty = ${tuple(vars.map(() => 'mempty'))}`,
  ];
}

function tupleFunctor(vars: string[], others: string[]): string[] {
  if (vars.length > MAX_FUNCTOR_TUPLE) return [];
  const prefix = vars.slice(0, -1);
  const applied = `((${','.repeat(vars.length - 1)}) ${prefix.join(' ')})`;
  return [
    `instance Functor ${applied} where`,
    `  fmap f ${tuple(vars)} = ${tuple([...prefix, `f ${vars.at(-1)}`])}`,
    ...tupleMonad(prefix, others.slice(0, -1), applied),
  ];
}

function tupleMonad(prefix: string[], others: string[], applied: string): string[] {
  if (prefix.length + 1 > MAX_MONAD_TUPLE) return [];
  const combined = prefix.map((value, index) => `${value} <> ${others[index]}`);
  return [
    `instance ${tupleContext('Monoid', prefix)} => Applicative ${applied} where`,
    `  pure x = ${tuple([...prefix.map(() => 'mempty'), 'x'])}`,
    `  ${tuple([...prefix, 'f'])} <*> ${tuple([...others, 'x'])} = ${tuple([...combined, 'f x'])}`,
    ...(prefix.length === 1
      ? [`  liftA2 f ${tuple([...prefix, 'x'])} ${tuple([...others, 'y'])} = ${tuple([...combined, 'f x y'])}`]
      : []),
    `instance ${tupleContext('Monoid', prefix)} => Monad ${applied} where`,
    `  ${tuple([...prefix, 'x'])} >>= k = case k x of ${tuple([...others, 'y'])} -> ${tuple([...combined, 'y'])}`,
  ];
}

function tupleContext(cls: string, vars: string[]): string {
  return `(${vars.map((name) => `${cls} ${name}`).join(', ')})`;
}

function tuple(names: string[]): string {
  return `(${names.join(', ')})`;
}

export const BASE_TUPLES = Array.from({ length: MAX_INSTANCE_TUPLE - 1 }, (_, index) => tupleSource(index + 2)).join(
  '\n'
);
