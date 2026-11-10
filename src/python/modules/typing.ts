import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { registerModule } from '../modules';
import { currentRuntime } from '../runtimeContext';
import { builtinClass, typingClass } from '../types';
import { PyClass, PyOpaque, PyTuple, type PyValue } from '../values';

const specialFormClass = builtinClass('_SpecialForm');
specialFormClass.module = 'typing';

function argumentText(value: PyValue): string {
  if (value instanceof PyClass)
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  if (value instanceof PyOpaque) return value.text;
  return pyRepr(value);
}

for (const cls of [specialFormClass, typingClass]) {
  method(cls, '__getitem__', 'one', 1, 1, (self, [key]) => {
    const args = key instanceof PyTuple ? key.items : [key];
    const text = (self as PyOpaque).text;
    // Since Python 3.14, Union and Optional are the same as the `|` union of their arguments.
    if (text === 'typing.Optional') return currentRuntime().unionType(args[0], currentRuntime().none);
    if (text === 'typing.Union') {
      let union = args[0];
      for (const arg of args.slice(1)) union = currentRuntime().unionType(union, arg);
      return union;
    }
    return new PyOpaque(typingClass, `${text}[${args.map(argumentText).join(', ')}]`);
  });
  method(cls, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);
  method(cls, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));
  method(cls, '__call__', 'expected', 0, Number.POSITIVE_INFINITY, (self) => {
    throw currentRuntime().unsupported(`${(self as PyOpaque).text} の呼び出し`);
  });
}

function form(name: string): PyValue {
  return new PyOpaque(specialFormClass, `typing.${name}`);
}

registerModule('typing', () => {
  return new Map<string, PyValue>([
    ...[
      'Any',
      'List',
      'Dict',
      'Set',
      'FrozenSet',
      'Tuple',
      'Optional',
      'Union',
      'Callable',
      'Iterable',
      'Iterator',
      'Sequence',
      'Mapping',
      'Generator',
      'Type',
      'Literal',
      'Final',
      'ClassVar',
      'Deque',
      'DefaultDict',
    ].map((name): [string, PyValue] => [name, form(name)]),
    ['TYPE_CHECKING', false],
    ['override', builtin('override', 'one', 1, 1, ([fn]) => fn)],
  ]);
});
