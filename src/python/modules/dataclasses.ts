import type { FunctionDef } from '../ast';
import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { callValue, isTruthy } from '../objects';
import { equals, lessThan } from '../operators';
import { parsePython } from '../parse';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  dictClass,
  exceptionClassNamed,
  functionClass,
  listClass,
  methodDescriptorClass,
  newDict,
  newTuple,
  None,
  NotImplemented,
  setClass,
  typeError,
  valueError,
} from '../types';
import {
  type Kwargs,
  PyBuiltinFunction,
  PyClass,
  PyDict,
  PyFunction,
  PyInstance,
  PyList,
  PyObject,
  PyOpaque,
  PyTuple,
  type PyValue,
} from '../values';
import { builtinClassWithBase } from './moduleClasses';

export const frozenInstanceErrorClass = builtinClassWithBase(
  'FrozenInstanceError',
  exceptionClassNamed('AttributeError'),
  'dataclasses'
);
const fieldClass = builtinClass('Field');
fieldClass.module = 'dataclasses';
const missingClass = builtinClass('_MISSING_TYPE');
const MISSING = new PyOpaque(missingClass, 'MISSING');

interface FieldSpec {
  name: string;
  default: PyValue;
  factory: PyValue;
  init: boolean;
  repr: boolean;
  compare: boolean;
}

function field(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    {
      qualified: 'field',
      min: 0,
      max: 0,
      style: 'takes',
      keywords: ['default', 'default_factory', 'init', 'repr', 'hash', 'compare', 'metadata', 'kw_only'],
    },
    args,
    kwargs
  );
  const spec: Omit<FieldSpec, 'name'> = {
    default: kwargs?.get('default') ?? MISSING,
    factory: kwargs?.get('default_factory') ?? MISSING,
    init: isTruthy(kwargs?.get('init') ?? true),
    repr: isTruthy(kwargs?.get('repr') ?? true),
    compare: isTruthy(kwargs?.get('compare') ?? true),
  };
  if (spec.default !== MISSING && spec.factory !== MISSING)
    throw valueError('cannot specify both default and default_factory');
  return new PyOpaque(fieldClass, 'Field', spec);
}

const fieldsOfClass = new WeakMap<PyClass, FieldSpec[]>();
/** The fields each `__repr__` that `@dataclass` generated shows, which `pprint` lays out itself. */
const generatedReprFields = new WeakMap<object, string[]>();

/** The names of the fields a dataclass instance's generated `__repr__` shows, or undefined for any other value. */
export function dataclassReprFields(value: PyValue): string[] | undefined {
  if (!(value instanceof PyInstance) || !value.cls.flags.isDataclass) return undefined;
  const repr = value.cls.lookup('__repr__');
  return repr instanceof PyBuiltinFunction ? generatedReprFields.get(repr) : undefined;
}

/** The fields of a dataclass, its bases' first, as `@dataclass` collects them from the annotations. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows how dataclasses collects inherited and own fields.
function collectFields(cls: PyClass): FieldSpec[] {
  const fields: FieldSpec[] = [];
  for (const base of cls.mro.slice(1).toReversed()) {
    for (const spec of fieldsOfClass.get(base) ?? []) {
      const index = fields.findIndex((each) => each.name === spec.name);
      if (index === -1) fields.push(spec);
      else fields[index] = spec;
    }
  }
  for (const name of cls.annotationNames) {
    const value = cls.dict.get(name);
    let spec: FieldSpec = { name, default: MISSING, factory: MISSING, init: true, repr: true, compare: true };
    if (value instanceof PyOpaque && value.cls === fieldClass) {
      spec = { name, ...(value.data as Omit<FieldSpec, 'name'>) };
      if (spec.default === MISSING) cls.dict.delete(name);
      else cls.dict.set(name, spec.default);
    } else if (value !== undefined) {
      spec.default = value;
    }
    if (
      spec.default instanceof PyObject &&
      [listClass, dictClass, setClass].some((type) => (spec.default as PyObject).cls === type)
    ) {
      throw valueError(
        `mutable default ${pyRepr(spec.default.cls)} for field ${name} is not allowed: use default_factory`
      );
    }
    const index = fields.findIndex((each) => each.name === name);
    if (index === -1) fields.push(spec);
    else fields[index] = spec;
  }
  return fields;
}

/** Builds `__init__` from Python source, as CPython's dataclasses does, so that its argument errors match CPython's. */
// code-gauge-allow functionNcss 46 -- Follows how dataclasses builds __init__ from defaults, factories, and init=False fields.
// code-gauge-allow functionCognitiveComplexity 30 -- Follows how dataclasses builds __init__ from defaults, factories, and init=False fields.
function initFunction(cls: PyClass, fields: FieldSpec[], frozen: boolean): PyFunction {
  const initFields = fields.filter((spec) => spec.init);
  let sawDefault = false;
  for (const spec of initFields) {
    const hasDefault = spec.default !== MISSING || spec.factory !== MISSING;
    if (!hasDefault && sawDefault) throw typeError(`non-default argument '${spec.name}' follows default argument`);
    sawDefault ||= hasDefault;
  }
  const params = initFields.map((spec) =>
    spec.default !== MISSING || spec.factory !== MISSING ? `${spec.name}=__default__` : spec.name
  );
  const lines = [`def __init__(self${params.map((param) => `, ${param}`).join('')}):`];
  for (const spec of fields) {
    if (spec.factory !== MISSING) {
      if (spec.init)
        lines.push(`    if ${spec.name} is __factory_marker__:`, `        ${spec.name} = __factory_${spec.name}__()`);
      else lines.push(`    ${spec.name} = __factory_${spec.name}__()`);
    } else if (!spec.init) {
      if (spec.default === MISSING) continue;
      lines.push(`    ${spec.name} = __default_${spec.name}__`);
    }
    lines.push(`    __set__(self, '${spec.name}', ${spec.name})`);
  }
  lines.push('    __post_init__(self)');
  const module = parsePython(`${lines.join('\n')}\n`);
  const statement = module.body[0];
  if (statement.kind !== 'functionDef') throw new Error('The generated __init__ is not a function');
  const marker = new PyOpaque(missingClass, 'factory');
  const globals = new Map<string, PyValue>([
    ['__factory_marker__', marker],
    [
      '__set__',
      new PyBuiltinFunction(methodDescriptorClass, '__set__', ([self, name, value]) => {
        (self as PyInstance).dict.set(name as string, value);
        return None;
      }),
    ],
    [
      '__post_init__',
      new PyBuiltinFunction(methodDescriptorClass, '__post_init__', ([self]) => {
        const postInit = cls.lookup('__post_init__');
        return postInit === undefined ? None : callValue(postInit, [self]);
      }),
    ],
  ]);
  for (const spec of fields) {
    if (spec.factory !== MISSING) globals.set(`__factory_${spec.name}__`, spec.factory);
    if (spec.default !== MISSING) globals.set(`__default_${spec.name}__`, spec.default);
  }
  globals.set('__builtins__', None);
  const def: FunctionDef = statement.fn;
  def.qualifiedName = `${cls.qualifiedName}.__init__`;
  const defaults = initFields
    .filter((spec) => spec.default !== MISSING || spec.factory !== MISSING)
    .map((spec) => (spec.factory === MISSING ? spec.default : marker));
  const fn = new PyFunction(functionClass, def, globals, new Map(), defaults, new Map(), undefined);
  fn.module = '__main__';
  void frozen;
  return fn;
}

function nativeMethod(cls: PyClass, name: string, run: (self: PyValue, args: PyValue[]) => PyValue): void {
  cls.dict.set(
    name,
    new PyBuiltinFunction(
      methodDescriptorClass,
      name,
      (args) => run(args[0], args.slice(1)),
      undefined,
      'method',
      cls.name
    )
  );
}

function valuesOf(instance: PyValue, fields: FieldSpec[]): PyValue[] {
  return fields.map((spec) => (instance as PyInstance).dict.get(spec.name) ?? None);
}

// code-gauge-allow functionNcss 38 -- Adds each method `@dataclass` generates for its options.
// code-gauge-allow functionCognitiveComplexity 26 -- Adds each method `@dataclass` generates for its options.
function processClass(
  cls: PyClass,
  options: { init: boolean; repr: boolean; eq: boolean; order: boolean; frozen: boolean }
): PyClass {
  const fields = collectFields(cls);
  fieldsOfClass.set(cls, fields);
  cls.flags.isDataclass = true;
  if (options.frozen) currentRuntime().frozenDataclasses.add(cls);
  if (options.init && !cls.dict.has('__init__')) cls.dict.set('__init__', initFunction(cls, fields, options.frozen));
  const shown = fields.filter((spec) => spec.repr);
  if (options.repr && !cls.dict.has('__repr__')) {
    nativeMethod(cls, '__repr__', (self) => {
      const instance = self as PyInstance;
      return `${instance.cls.qualifiedName}(${shown.map((spec) => `${spec.name}=${pyRepr(instance.dict.get(spec.name) ?? None)}`).join(', ')})`;
    });
    generatedReprFields.set(
      cls.dict.get('__repr__') as object,
      shown.map((spec) => spec.name)
    );
  }
  const compared = fields.filter((spec) => spec.compare);
  if (options.eq && !cls.dict.has('__eq__')) {
    nativeMethod(cls, '__eq__', (self, [other]) => {
      if (!(other instanceof PyInstance) || other.cls !== (self as PyInstance).cls) return NotImplemented;
      const a = valuesOf(self, compared);
      const b = valuesOf(other, compared);
      return a.every((value, index) => equals(value, b[index]));
    });
  }
  if (options.order) {
    for (const [name, test] of [
      ['__lt__', (a: PyValue[], b: PyValue[]) => compareTuples(a, b) < 0],
      ['__le__', (a: PyValue[], b: PyValue[]) => compareTuples(a, b) <= 0],
      ['__gt__', (a: PyValue[], b: PyValue[]) => compareTuples(a, b) > 0],
      ['__ge__', (a: PyValue[], b: PyValue[]) => compareTuples(a, b) >= 0],
    ] as const) {
      nativeMethod(cls, name, (self, [other]) => {
        if (!(other instanceof PyInstance) || other.cls !== (self as PyInstance).cls) return NotImplemented;
        return test(valuesOf(self, compared), valuesOf(other, compared));
      });
    }
  }
  if (options.eq && options.frozen) {
    nativeMethod(cls, '__hash__', (self) => currentRuntime().hashOf(newTuple(valuesOf(self, compared))));
  } else if (options.eq && !cls.dict.has('__hash__')) {
    cls.dict.set('__hash__', None);
  }
  if (cls.dict.get('__hash__') === None && !options.eq) cls.dict.delete('__hash__');
  if (!cls.dict.has('__match_args__'))
    cls.dict.set('__match_args__', newTuple(fields.filter((spec) => spec.init).map((spec) => spec.name)));
  return cls;
}

function compareTuples(a: PyValue[], b: PyValue[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (equals(a[index], b[index])) continue;
    return lessThan(a[index], b[index]) ? -1 : 1;
  }
  return a.length - b.length;
}

function dataclass(args: PyValue[], kwargs: Kwargs): PyValue {
  const options = {
    init: isTruthy(kwargs?.get('init') ?? true),
    repr: isTruthy(kwargs?.get('repr') ?? true),
    eq: isTruthy(kwargs?.get('eq') ?? true),
    order: isTruthy(kwargs?.get('order') ?? false),
    frozen: isTruthy(kwargs?.get('frozen') ?? false),
  };
  if (options.order && !options.eq) throw valueError('eq must be true if order is true');
  const [cls] = args;
  if (cls instanceof PyClass) return processClass(cls, options);
  if (cls !== undefined && cls !== None) throw typeError('dataclass() should be called on a class');
  return builtin('wrap', 'one', 1, 1, ([target]) => {
    if (!(target instanceof PyClass)) throw typeError('dataclass() should be called on a class');
    return processClass(target, options);
  });
}

/** `asdict()`: a dataclass's fields as a dict, converting nested dataclasses and copying containers. */
function asdict(value: PyValue, asTuple: boolean): PyValue {
  if (value instanceof PyInstance && value.cls.flags.isDataclass) {
    const fields = fieldsOfClass.get(value.cls) ?? [];
    if (asTuple) return newTuple(fields.map((spec) => asdict(value.dict.get(spec.name) ?? None, asTuple)));
    return newDict(fields.map((spec) => [spec.name, asdict(value.dict.get(spec.name) ?? None, asTuple)]));
  }
  if (value instanceof PyList) return currentRuntime().listOf(value.items.map((item) => asdict(item, asTuple)));
  if (value instanceof PyTuple) return newTuple(value.items.map((item) => asdict(item, asTuple)));
  if (value instanceof PyDict) {
    return newDict(value.store.ordered().map((entry) => [asdict(entry.key, asTuple), asdict(entry.value, asTuple)]));
  }
  return value;
}

function requireDataclass(value: PyValue, name: string): void {
  if (!(value instanceof PyInstance && value.cls.flags.isDataclass)) {
    throw typeError(`${name}() should be called on dataclass instances`);
  }
}

method(fieldClass, '__repr__', 'none', 0, 0, () => 'Field(...)');

registerModule(
  'dataclasses',
  () =>
    new Map<string, PyValue>([
      [
        'dataclass',
        builtin('dataclass', 'takes', 0, 1, dataclass, {
          keywords: [
            'init',
            'repr',
            'eq',
            'order',
            'unsafe_hash',
            'frozen',
            'match_args',
            'kw_only',
            'slots',
            'weakref_slot',
          ],
        }),
      ],
      [
        'field',
        builtin('field', 'takes', 0, 0, field, {
          keywords: ['default', 'default_factory', 'init', 'repr', 'hash', 'compare', 'metadata', 'kw_only'],
        }),
      ],
      [
        'asdict',
        builtin('asdict', 'one', 1, 1, ([value]) => {
          requireDataclass(value, 'asdict');
          return asdict(value, false);
        }),
      ],
      [
        'astuple',
        builtin('astuple', 'one', 1, 1, ([value]) => {
          requireDataclass(value, 'astuple');
          return asdict(value, true);
        }),
      ],
      [
        'is_dataclass',
        builtin(
          'is_dataclass',
          'one',
          1,
          1,
          ([value]) => (value instanceof PyClass ? value : (value as PyObject).cls)?.flags?.isDataclass === true
        ),
      ],
      ['FrozenInstanceError', frozenInstanceErrorClass],
      ['MISSING', MISSING],
    ])
);

export { argument };
