import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { aliasArgumentText, isUnionable, PyGenericAlias } from '../genericAlias';
import { registerModule } from '../modules';
import { getAttribute, setAttribute } from '../objects';
import { equals } from '../operators';
import { currentRuntime } from '../runtimeContext';
import {
  genericClass,
  mroEntryHooks,
  NoDefault,
  paramSpecClass,
  PyTypingAlias,
  typeAliasClass,
  typeVarClass,
  typeVarTupleClass,
} from '../typeParams';
import {
  builtinClass,
  classOf,
  Ellipsis,
  newSet,
  None,
  NotImplemented,
  objectClass,
  pyError,
  typeClass,
  typeError,
  typingClass,
  unionClass,
} from '../types';
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
  if (value instanceof PyGenericAlias) return aliasArgumentText(value);
  if (value instanceof PyOpaque) return value.text;
  // `typing._type_repr`, after the subscript turned None into its type, and Callable's list of argument types.
  if (value === None) return 'NoneType';
  if (value === Ellipsis) return '...';
  if (value instanceof PyList) return `[${value.items.map(argumentText).join(', ')}]`;
  return pyRepr(value);
}

// A union compares and hashes as the set of its members.
const unionMembers = (union: PyValue): PyValue[] => (union as PyOpaque).data as PyValue[];
method(unionClass, '__eq__', 'one', 1, 1, (self, [other]) => {
  if (!(other instanceof PyOpaque) || other.cls !== unionClass) return NotImplemented;
  const [mine, theirs] = [unionMembers(self), unionMembers(other)];
  return mine.length === theirs.length && mine.every((member) => theirs.some((each) => equals(each, member)));
});
method(unionClass, '__hash__', 'none', 0, 0, (self) => currentRuntime().hashOf(newSet(unionMembers(self), true)));

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
    return new PyOpaque(cls, `${text}[${args.map(argumentText).join(', ')}]`, { form: formName(text), args });
  });
  // A builtin alias and a union take part in `|` only with what `types.UnionType` accepts.
  const accepts = cls === typingClass || cls === unionClass ? isUnionable : () => true;
  method(cls, '__or__', 'one', 1, 1, (self, [other]) =>
    accepts(other) ? currentRuntime().unionType(self, other) : NotImplemented
  );
  method(cls, '__ror__', 'one', 1, 1, (self, [other]) =>
    accepts(other) ? currentRuntime().unionType(other, self) : NotImplemented
  );
  if (cls === typingClass) continue;
  method(cls, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);
  method(cls, '__call__', 'expected', 0, Number.POSITIVE_INFINITY, (self) => {
    throw currentRuntime().unsupported(`${(self as PyOpaque).text} の呼び出し`);
  });
}

/** The name of a special form, such as `List` of `typing.List`, which an alias of it records. */
function formName(text: string): string {
  return text.slice('typing.'.length);
}

// Typing aliases as bases ---------------------------------------------------------------------------------------------

/** The classes the aliases of `typing` stand for, by module, as their `__origin__`. */
const ALIAS_ORIGINS: Record<string, [string, string]> = {
  List: ['builtins', 'list'],
  Dict: ['builtins', 'dict'],
  Set: ['builtins', 'set'],
  FrozenSet: ['builtins', 'frozenset'],
  Tuple: ['builtins', 'tuple'],
  Type: ['builtins', 'type'],
  Deque: ['collections', 'deque'],
  DefaultDict: ['collections', 'defaultdict'],
  Callable: ['collections.abc', 'Callable'],
  Iterable: ['collections.abc', 'Iterable'],
  Iterator: ['collections.abc', 'Iterator'],
  Sequence: ['collections.abc', 'Sequence'],
  Mapping: ['collections.abc', 'Mapping'],
  Generator: ['collections.abc', 'Generator'],
};

/** `typing._AnyMeta`, the metaclass of `typing.Any`, which CPython makes a class programs may derive from. */
const anyMetaClass = builtinClass('_AnyMeta', typeClass, true);
anyMetaClass.module = 'typing';
const anyClass = new PyClass('Any', [objectClass], anyMetaClass);
anyClass.mro = [anyClass, objectClass];
anyClass.isBaseType = true;
anyClass.module = 'typing';
anyClass.construct = () => {
  throw typeError('Any cannot be instantiated');
};
method(anyMetaClass, '__repr__', 'none', 0, 0, (self) =>
  self === anyClass ? 'typing.Any' : `<class '${(self as PyClass).module}.${(self as PyClass).qualifiedName}'>`
);
method(anyMetaClass, '__instancecheck__', 'one', 1, 1, (self, [value]) => {
  if (self === anyClass) throw typeError('typing.Any cannot be used with isinstance()');
  return classOf(value).isSubclassOf(self as PyClass);
});

/** The form of a `typing` special form or alias of one, or undefined for any other value. */
function typingForm(value: PyValue): { form: string; args?: PyValue[] } | undefined {
  if (!(value instanceof PyOpaque)) return undefined;
  if (value.cls === specialFormClass) return { form: formName(value.text) };
  if (value.cls === formAliasClass || value.cls === literalAliasClass)
    return value.data as { form: string; args: PyValue[] };
  return undefined;
}

/** `_BaseGenericAlias.__mro_entries__`: the origin class, and Generic unless a later base brings it. */
mroEntryHooks.push((base, _className, bases) => {
  if (base instanceof PyOpaque && base.cls === unionClass) throw typeError(`Cannot subclass ${base.text}`);
  const typing = typingForm(base);
  if (!typing) return;
  if (typing.form === 'Annotated' && typing.args) return [typing.args[0]];
  const location = ALIAS_ORIGINS[typing.form];
  if (!location) throw typeError(`Cannot subclass ${(base as PyOpaque).text}`);
  const runtime = currentRuntime();
  const origin =
    location[0] === 'builtins'
      ? (runtime.builtins.get(location[1]) as PyValue)
      : getAttribute(runtime.importModule(location[0]), location[1]);
  const entries = bases.includes(origin) ? [] : [origin];
  const later = bases.slice(bases.indexOf(base) + 1);
  const bringsGeneric = later.some(
    (other) =>
      typingForm(other) !== undefined ||
      other instanceof PyTypingAlias ||
      (other instanceof PyClass && other.isSubclassOf(genericClass))
  );
  if (!bringsGeneric) entries.push(genericClass);
  return entries;
});

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
    ['Any', anyClass],
    ...[
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
