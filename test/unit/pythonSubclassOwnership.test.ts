import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['dict', 'set', 'bytes', 'list', 'tuple', 'str', 'int', 'float', 'bytearray'])(
  'a live %s subclass retains class-owned resources through collection and method calls',
  (base) => {
    const program = `import gc
class Resource:
    def __init__(self): self.closed = False
    def __del__(self):
        self.closed = True
        print('released')
def create():
    class Value(${base}):
        def closed(self, resource=Resource()): return resource.closed
    return Value()
value = create()
print('created')
gc.collect()
print(value.closed())
del value
gc.collect()
print('end')`;
    expect(executeProgram('python', program)).toMatchObject({
      kind: 'executed',
      stdout: 'created\nFalse\nreleased\nend\n',
      uncaughtException: undefined,
    });
  }
);
