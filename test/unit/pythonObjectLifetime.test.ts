import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('suspended generators close when reference counting would free them, not when a cycle keeps them', () => {
  expectSameAsCPython(`import gc
log = []
def gen(tag):
    try:
        yield 1
    finally:
        log.append(tag)
def opened(tag):
    g = gen(tag)
    next(g)
    return g
def take(it):
    return next(it)
def raiser(tag):
    g = opened(tag)
    raise KeyError(tag)
g = opened('rebound')
g = None
log.append('-')
x = take(gen('argument'))
log.append('-')
items = [opened('item')]
items.pop()
log.append('-')
box = {'k': opened('value')}
box['k'] = 0
log.append('-')
try:
    raiser('traceback')
except KeyError:
    log.append('handler')
log.append('-')
class Node:
    pass
a, b = Node(), Node()
a.other, b.other, a.g = b, a, opened('cycle')
a = b = None
log.append('dropped cycle')
gc.collect()
expected = ['rebound', '-', 'argument', '-', 'item', '-', 'value', '-', 'handler', 'traceback', '-', 'dropped cycle', 'cycle']
if log != expected:
    raise AssertionError(log)
`);
});

test('objects keep one live __dict__, and builtin methods have the types CPython gives them', () => {
  expectSameAsCPython(`class B:
    pass
b = B()
d = b.__dict__
d['x'] = 1
replacement = {'y': 2}
b.__dict__ = replacement
b.z = 3
results = (d is not b.__dict__, b.__dict__ is replacement, replacement, type(B.__dict__).__name__)
if results != (True, True, {'y': 2, 'z': 3}, 'mappingproxy'):
    raise AssertionError(results)
kinds = [type(value).__name__ for value in (str.upper, 'x'.upper, int.__add__, (1).__add__, len, object.__new__)]
expected = ['method_descriptor', 'builtin_function_or_method', 'wrapper_descriptor', 'method-wrapper',
            'builtin_function_or_method', 'builtin_function_or_method']
if kinds != expected:
    raise AssertionError(kinds)
texts = [repr(value) for value in (str.upper, int.__add__, len)]
if texts != ["<method 'upper' of 'str' objects>", "<slot wrapper '__add__' of 'int' objects>", '<built-in function len>']:
    raise AssertionError(texts)
`);
});
