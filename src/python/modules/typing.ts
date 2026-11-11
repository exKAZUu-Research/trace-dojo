import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { registerModule } from '../modules';
import { setAttribute } from '../objects';
import { currentRuntime } from '../runtimeContext';
import {
  genericClass,
  NoDefault,
  paramSpecClass,
  typeAliasClass,
  typeVarClass,
  typeVarTupleClass,
} from '../typeParams';
import { builtinClass, Ellipsis, None, pyError, typingClass, unionClass } from '../types';
import { PyClass, PyError, PyList, PyOpaque, PyTuple, type PyValue } from '../values';
import { TYPING_CLASSES } from './typingClasses';
import { getTypeHints, newTypeClass } from './typingTypeVars';

const specialFormClass = builtinClass('_SpecialForm');
specialFormClass.module = 'typing';
/** `typing._GenericAlias`, the class of a typing construct subscripted, such as `typing.List[int]`. */
const formAliasClass = builtinClass('_GenericAlias');
formAliasClass.module = 'typing';
const literalAliasClass = builtinClass('_LiteralGenericAlias');
literalAliasClass.module = 'typing';

function argumentText(value: PyValue): string {
  if (value instanceof PyClass)
    return value.module === 'builtins' ? value.qualifiedName : `${value.module}.${value.qualifiedName}`;
  if (value instanceof PyOpaque) return value.text;
  // `typing._type_repr`, after the subscript turned None into its type, and Callable's list of argument types.
  if (value === None) return 'NoneType';
  if (value === Ellipsis) return '...';
  if (value instanceof PyList) return `[${value.items.map(argumentText).join(', ')}]`;
  return pyRepr(value);
}

for (const cls of [specialFormClass, typingClass, unionClass, formAliasClass, literalAliasClass]) {
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
    const cls =
      self instanceof PyOpaque && self.cls === typingClass
        ? typingClass
        : text === 'typing.Literal'
          ? literalAliasClass
          : formAliasClass;
    return new PyOpaque(cls, `${text}[${args.map(argumentText).join(', ')}]`);
  });
  method(cls, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);
  method(cls, '__or__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(self, other));
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) => currentRuntime().unionType(other, self));
  method(cls, '__call__', 'expected', 0, Number.POSITIVE_INFINITY, (self) => {
    throw currentRuntime().unsupported(`${(self as PyOpaque).text} の呼び出し`);
  });
}

/** What `@overload` replaces each overload with, which the implementation that follows them replaces in turn. */
const overloadDummy = builtin('_overload_dummy', 'expected', 0, Number.POSITIVE_INFINITY, () => {
  throw pyError(
    'NotImplementedError',
    'You should not call an overloaded function. A series of @overload-decorated functions outside a stub module should always be followed by an implementation that is not @overload-ed.'
  );
});

/** `@final`, which marks a class or a function with `__final__`, as checkers read it. */
function markFinal(value: PyValue): PyValue {
  try {
    setAttribute(value, '__final__', true);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
  }
  return value;
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
      'Annotated',
      'NoReturn',
      'Never',
      'Self',
      'Required',
      'NotRequired',
      'TypeGuard',
      'Unpack',
    ].map((name): [string, PyValue] => [name, form(name)]),
    ['TYPE_CHECKING', false],
    ['override', builtin('override', 'one', 1, 1, ([fn]) => fn)],
    ['TypeVar', typeVarClass],
    ['ParamSpec', paramSpecClass],
    ['TypeVarTuple', typeVarTupleClass],
    ['TypeAliasType', typeAliasClass],
    ['Generic', genericClass],
    ['NoDefault', NoDefault],
    ['NewType', newTypeClass],
    ['cast', builtin('cast', 'takes', 2, 2, ([, value]) => value, { keywords: ['typ', 'val'] })],
    [
      'get_type_hints',
      builtin('get_type_hints', 'takes', 1, 3, getTypeHints, {
        keywords: ['obj', 'globalns', 'localns', 'include_extras'],
      }),
    ],
    ['final', builtin('final', 'one', 1, 1, ([value]) => markFinal(value))],
    ['overload', builtin('overload', 'one', 1, 1, () => overloadDummy)],
    ...TYPING_CLASSES,
  ]);
});
