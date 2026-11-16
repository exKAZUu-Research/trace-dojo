// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { type CallRecord, callStack } from './calls';
import { createObject, findClass } from './classes';
import { formatFloatRepr } from './conversions';
import { setErrorFactories } from './errors';
import { callMethod, callValue } from './callables';
import { type ClassDefinition, defineClass, type NativeMethod } from './native';
import { toStr } from './operators';
import { rt, SCRIPT_PATH } from './runtime';
import { PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

/** Sets the file, line, and trace of a new throwable, as PHP does when the object is created. */
function initThrowable(object: PhpObject): undefined {
  const runtime = rt();
  object.props.set('file', SCRIPT_PATH);
  object.props.set('line', BigInt(runtime.row + 1));
  object.props.set(`\0${baseClassOf(object.cls).name}\0trace`, traceArray(callStack.toReversed()));
  return undefined;
}

/** Exception or Error, whose private properties every throwable shares. */
function baseClassOf(cls: PhpClass): PhpClass {
  let current = cls;
  while (current.parent) current = current.parent;
  return current;
}

function privateKey(object: PhpObject, name: string): string {
  return `\0${baseClassOf(object.cls).name}\0${name}`;
}

function traceArray(records: CallRecord[]): PhpArray {
  const trace = new PhpArray();
  for (const record of records) {
    const frame = new PhpArray();
    if (record.row !== undefined) {
      frame.set('file', SCRIPT_PATH);
      frame.set('line', BigInt(record.row + 1));
    }
    frame.set('function', record.name);
    if (record.className !== undefined) {
      frame.set('class', record.className);
      frame.set('type', record.type ?? '::');
    }
    frame.set('args', PhpArray.list(record.args));
    trace.append(frame);
  }
  return trace;
}

/** Formats a stack trace as `getTraceAsString` does, from records innermost first. */
export function traceText(records: CallRecord[]): string {
  const lines = records.map((record, index) => {
    const where = record.row === undefined ? '[internal function]' : `${SCRIPT_PATH}(${record.row + 1})`;
    const name = record.className ? `${record.className}${record.type}${record.name}` : record.name;
    return `#${index} ${where}: ${name}(${record.args.map((arg) => traceArg(arg)).join(', ')})`;
  });
  lines.push(`#${records.length} {main}`);
  return lines.join('\n');
}

function traceArrayText(trace: Value): string {
  if (!(trace instanceof PhpArray)) return '#0 {main}';
  const lines: string[] = [];
  let index = 0;
  for (const frame of trace.values()) {
    if (!(frame instanceof PhpArray)) continue;
    const file = frame.get('file');
    const line = frame.get('line');
    const where = file === undefined ? '[internal function]' : `${toStr(file)}(${toStr(line ?? null)})`;
    const className = frame.get('class');
    const name =
      className === undefined
        ? toStr(frame.get('function') ?? '')
        : `${toStr(className)}${toStr(frame.get('type') ?? '')}${toStr(frame.get('function') ?? '')}`;
    const args = frame.get('args');
    const argsText =
      args instanceof PhpArray
        ? args
            .values()
            .map((arg) => traceArg(arg))
            .join(', ')
        : '';
    lines.push(`#${index++} ${where}: ${name}(${argsText})`);
  }
  lines.push(`#${index} {main}`);
  return lines.join('\n');
}

function traceArg(value: Value): string {
  if (value === null) return 'NULL';
  switch (typeof value) {
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'bigint': {
      return value.toString();
    }
    case 'number': {
      return formatFloatRepr(value);
    }
    case 'string': {
      return value.length > 15 ? `'${value.slice(0, 15)}...'` : `'${value}'`;
    }
  }
  if (value instanceof PhpArray) return 'Array';
  return `Object(${(value as PhpObject).cls.name})`;
}

/** The text of a throwable as `__toString` gives it, which an uncaught exception prints. */
export function throwableText(object: PhpObject): string {
  const method = object.cls.findMethod('__tostring');
  if (method && method.fn.kind === 'user') return toStr(callMethod(object, '__toString', []));
  return defaultThrowableText(object);
}

function defaultThrowableText(object: PhpObject): string {
  const parts: string[] = [];
  const chain: PhpObject[] = [];
  for (let current: Value = object; current instanceof PhpObject && chain.length < 64;) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = current.props.get(privateKey(current, 'previous')) as Value;
  }
  for (const item of chain.toReversed()) {
    const message = toStr(item.props.get('message') as Value);
    const header = message === '' ? item.cls.name : `${item.cls.name}: ${message}`;
    const line = item.props.get('line');
    const text = `${header} in ${toStr(item.props.get('file') as Value)}:${toStr(line as Value)}\nStack trace:\n${traceArrayText(item.props.get(privateKey(item, 'trace')) as Value)}`;
    parts.push(text);
  }
  return parts.join('\n\nNext ');
}

function createThrowable(className: string, message: string, code = 0n): PhpObject {
  const cls = findClass(className) as PhpClass;
  const object = createObject(cls);
  object.props.set('message', message);
  object.props.set('code', code);
  return object;
}

/** Calls a user error handler set with `set_error_handler`, telling whether it handled the error. */
function callUserHandler(handler: Value, level: bigint, message: string, row: number): boolean {
  const runtime = rt();
  const saved = runtime.errorHandlers;
  // The handler runs without itself, so that an error inside it reaches the default handling.
  runtime.errorHandlers = [];
  try {
    const result = callValue(
      handler,
      [{ v: level }, { v: message }, { v: SCRIPT_PATH }, { v: BigInt(row + 1) }],
      undefined
    );
    return result !== false;
  } finally {
    runtime.errorHandlers = saved;
  }
}

setErrorFactories(createThrowable, callUserHandler);

const throwableMethods = (base: string): NativeMethod[] => [
  {
    signature: '__construct(string $message = "", int $code = 0, ?Throwable $previous = null)',
    impl: ({ thisObj, args }) => {
      const [message, code, previous] = args;
      if (message !== undefined) thisObj.props.set('message', message);
      if (code !== undefined) thisObj.props.set('code', code);
      if (previous !== undefined) thisObj.props.set(`\0${base}\0previous`, previous);
      return null;
    },
  },
  { signature: 'getMessage(): string', isFinal: true, impl: ({ thisObj }) => slotValue(thisObj, 'message') },
  { signature: 'getCode()', isFinal: true, impl: ({ thisObj }) => slotValue(thisObj, 'code') },
  {
    signature: 'getPrevious(): ?Throwable',
    isFinal: true,
    impl: ({ thisObj }) => slotValue(thisObj, `\0${base}\0previous`),
  },
  { signature: 'getFile(): string', isFinal: true, impl: ({ thisObj }) => slotValue(thisObj, 'file') },
  { signature: 'getLine(): int', isFinal: true, impl: ({ thisObj }) => slotValue(thisObj, 'line') },
  { signature: 'getTrace(): array', isFinal: true, impl: ({ thisObj }) => slotValue(thisObj, `\0${base}\0trace`) },
  {
    signature: 'getTraceAsString(): string',
    isFinal: true,
    impl: ({ thisObj }) => traceArrayText(slotValue(thisObj, `\0${base}\0trace`)),
  },
  { signature: '__toString(): string', impl: ({ thisObj }) => defaultThrowableText(thisObj) },
];

function slotValue(object: PhpObject, key: string): Value {
  const slot = object.props.get(key);
  if (slot instanceof Ref) return slot.v;
  if (slot === undefined || typeof slot === 'symbol') return null;
  return slot;
}

function throwableProps(): NonNullable<ClassDefinition['props']> {
  return [
    { name: 'message', visibility: 'protected', defaultValue: () => '' },
    { name: 'string', visibility: 'private', defaultValue: () => '' },
    { name: 'code', visibility: 'protected', defaultValue: () => 0n },
    { name: 'file', visibility: 'protected', defaultValue: () => '' },
    { name: 'line', visibility: 'protected', defaultValue: () => 0n },
    { name: 'trace', visibility: 'private', defaultValue: () => new PhpArray() },
    { name: 'previous', visibility: 'private', defaultValue: () => null },
  ];
}

defineClass({
  name: 'Throwable',
  kind: 'interface',
  interfaces: ['Stringable'],
  methods: [
    'getMessage(): string',
    'getCode()',
    'getFile(): string',
    'getLine(): int',
    'getTrace(): array',
    'getPrevious(): ?Throwable',
    'getTraceAsString(): string',
  ].map((signature) => ({ signature, impl: () => null, isAbstract: true })),
});

for (const base of ['Exception', 'Error']) {
  defineClass({
    name: base,
    interfaces: ['Stringable', 'Throwable'],
    props: throwableProps(),
    methods: throwableMethods(base),
    createInternal: initThrowable,
  });
}

defineClass({
  name: 'ErrorException',
  parent: 'Exception',
  props: [{ name: 'severity', visibility: 'protected', defaultValue: () => 1n }],
  methods: [
    {
      signature:
        '__construct(string $message = "", int $code = 0, int $severity = E_ERROR, ?string $filename = null, ?int $line = null, ?Throwable $previous = null)',
      impl: ({ thisObj, args }) => {
        const [message, code, severity, filename, line, previous] = args;
        if (message !== undefined) thisObj.props.set('message', message);
        if (code !== undefined) thisObj.props.set('code', code);
        if (severity !== undefined) thisObj.props.set('severity', severity);
        if (filename !== undefined && filename !== null) thisObj.props.set('file', filename);
        if (line !== undefined && line !== null) thisObj.props.set('line', line);
        if (previous !== undefined) thisObj.props.set('\0Exception\0previous', previous);
        return null;
      },
    },
    { signature: 'getSeverity(): int', isFinal: true, impl: ({ thisObj }) => slotValue(thisObj, 'severity') },
  ],
});

const subclasses: [string, string][] = [
  ['TypeError', 'Error'],
  ['ValueError', 'Error'],
  ['ArithmeticError', 'Error'],
  ['DivisionByZeroError', 'ArithmeticError'],
  ['ArgumentCountError', 'TypeError'],
  ['AssertionError', 'Error'],
  ['UnhandledMatchError', 'Error'],
  ['CompileError', 'Error'],
  ['ParseError', 'CompileError'],
  ['RuntimeException', 'Exception'],
  ['LogicException', 'Exception'],
  ['BadFunctionCallException', 'LogicException'],
  ['BadMethodCallException', 'BadFunctionCallException'],
  ['DomainException', 'LogicException'],
  ['InvalidArgumentException', 'LogicException'],
  ['LengthException', 'LogicException'],
  ['OutOfRangeException', 'LogicException'],
  ['OutOfBoundsException', 'RuntimeException'],
  ['OverflowException', 'RuntimeException'],
  ['RangeException', 'RuntimeException'],
  ['UnderflowException', 'RuntimeException'],
  ['UnexpectedValueException', 'RuntimeException'],
  ['JsonException', 'Exception'],
];
for (const [name, parent] of subclasses) defineClass({ name, parent });
