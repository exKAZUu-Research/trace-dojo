import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['module', 'function', 'coroutine'])(
  'calls record stored arguments before dropping temporary holds (%s)',
  (scope) => {
    const body = `items = []
items.append(R('one'))
items.insert(0, R('two'))
print([item.name for item in items])
items.clear()
print('cleared')`;
    const indented = body
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    const program = `import asyncio
class R:
    def __init__(self, name): self.name = name
    def __del__(self): print('del', self.name)
def default(value=R('default')): return value
default()
${scope === 'module' ? body : `${scope === 'coroutine' ? 'async ' : ''}def run():\n${indented}\n${scope === 'coroutine' ? 'asyncio.run(run())' : 'run()'}`}
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: "['two', 'one']\ndel one\ndel two\ncleared\nend\ndel default\n",
      uncaughtException: undefined,
    });
  }
);

test.each([
  [false, 'error.args[0]', 'R'],
  [false, 'error', 'ValueError'],
  [true, 'error.args[0]', 'R'],
  [true, 'error', 'ValueError'],
] as const)('handler return values survive exception teardown (async=%s, expression=%s)', (async, expression, type) => {
  const program = `import asyncio
class R:
    def __del__(self): print('released')
${async ? 'async ' : ''}def get():
    try: raise ValueError(R())
    except ValueError as error:
        ${async ? 'await asyncio.sleep(0)' : 'pass'}
        return ${expression}
value = ${async ? 'asyncio.run(get())' : 'get()'}
print('returned', type(value).__name__)
del value
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: `returned ${type}\nreleased\nend\n`,
    uncaughtException: undefined,
  });
});

test('a completed task retained by the caller still owns its result', () => {
  const program = `import asyncio
class R:
    def __del__(self): print('released')
async def produce(): return R()
async def main():
    task = asyncio.create_task(produce())
    await task
    return task
task = asyncio.run(main())
print(type(task.result()).__name__)
del task
print('end')`;
  expect(executeProgram('python', program)).toMatchObject({
    kind: 'executed',
    stdout: 'R\nreleased\nend\n',
    uncaughtException: undefined,
  });
});
