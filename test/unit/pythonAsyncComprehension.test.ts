import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['[await double(x) for x in await values()]', '[x for x in await values() if await double(x)]'])(
  'awaiting a comprehension iterable still marks its body: %s',
  (expression) => {
    const program = `async def values(): return [1, 2]
async def double(x): return x * 2
async def main(): return ${expression}
c = main()
try: c.send(None)
except StopIteration as error: print(error.value)`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: expression.startsWith('[await') ? '[2, 4]\n' : '[1, 2]\n',
      uncaughtException: undefined,
    });
  }
);
