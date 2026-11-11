import { method } from './define';
import type { Runtime } from './runtime';
import { strLength } from './strings';
import { builtinClass, nativeFunction, None, propertyClass, typeError, typeName } from './types';
import { PyDescriptor, PyOpaque, type PyValue } from './values';

const textIOClass = builtinClass('TextIOWrapper');
textIOClass.module = '_io';
method(textIOClass, 'write', 'one', 1, 1, (self, [text]) => {
  if (typeof text !== 'string') throw typeError(`write() argument must be str, not ${typeName(text)}`);
  (self as PyOpaque & { data: (text: string) => void }).data(text);
  return BigInt(strLength(text));
});
method(textIOClass, 'flush', 'none', 0, 0, () => None);
for (const [name, read] of [
  ['name', (self: PyOpaque): PyValue => `<${self.text}>`],
  ['encoding', (): PyValue => 'utf8'],
  ['errors', (self: PyOpaque): PyValue => (self.text === 'stderr' ? 'backslashreplace' : 'surrogateescape')],
  ['mode', (): PyValue => 'w'],
] as const) {
  textIOClass.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      nativeFunction(name, ([self]) => read(self as PyOpaque))
    )
  );
}
method(
  textIOClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<_io.TextIOWrapper name='<${(self as PyOpaque).text}>' mode='w' encoding='utf-8'>`
);

/** `sys.stdout` or `sys.stderr`, whose writes go to the program's output or to the hidden error output. */
export function createStream(runtime: Runtime, name: 'stdout' | 'stderr'): PyValue {
  const write =
    name === 'stdout' ? (text: string) => runtime.budget.print(text) : (text: string) => (runtime.errorOutput += text);
  return new PyOpaque(textIOClass, name, write);
}
