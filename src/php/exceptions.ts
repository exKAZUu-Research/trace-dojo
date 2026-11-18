// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod, callValue } from './callables';
import { asInternal, callArguments, callNamedArguments, type CallRecord, callStack } from './calls';
import { createObject, findClass } from './classes';
import { formatFloat } from './conversions';
import { setErrorFactories, setThrowableFormatter, throwableKey } from './errors';
import { type ClassDefinition, defineClass, type NativeMethod } from './native';
import { toStr } from './operators';
import { rt, SCRIPT_PATH } from './runtime';
import { PhpArray, type PhpClass, PhpObject, Ref, type Value } from './values';

/** Sets the file, line, and trace of a new throwable, as PHP does when the object is created. */
function initThrowable(object: PhpObject): undefined {
  const runtime = rt();
  object.props.set('file', SCRIPT_PATH);
  object.props.set('line', BigInt(runtime.row + 1));
  object.props.set(throwableKey(object, 'trace'), traceArray(callStack.toReversed()));
  return undefined;
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
    const args = PhpArray.list(callArguments(record));
    for (const [name, value] of callNamedArguments(record)) args.set(name, value);
    frame.set('args', args);
    trace.append(frame);
  }
  return trace;
}

export function traceText(records: CallRecord[]): string {
  return [...records.map((record, index) => traceLine(record, index)), `#${records.length} {main}`].join('\n');
}

export function traceLine(record: CallRecord, index: number, ignoreArguments = false): string {
  const where = record.row === undefined ? '[internal function]' : `${SCRIPT_PATH}(${record.row + 1})`;
  const name = record.className ? `${record.className}${record.type}${record.name}` : record.name;
  const args = ignoreArguments
    ? []
    : [
        ...callArguments(record).map(traceArg),
        ...callNamedArguments(record).map(([key, value]) => `${key}: ${traceArg(value)}`),
      ];
  return `#${index} ${where}: ${name}(${args.join(', ')})`;
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
        ? [...args.entries()]
            .map(([key, arg]) => (typeof key === 'string' ? `${key}: ${traceArg(arg)}` : traceArg(arg)))
            .join(', ')
        : '';
    lines.push(`#${index++} ${where}: ${name}(${argsText})`);
  }
  lines.push(`#${index} {main}`);
  return lines.join('\n');
}

export function traceArg(value: Value): string {
  if (value === null) return 'NULL';
  switch (typeof value) {
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'bigint': {
      return value.toString();
    }
    case 'number': {
      const text = formatFloat(value, 14);
      return Number.isFinite(value) && !/[.E]/.test(text) ? `${text}.0` : text;
    }
    case 'string': {
      const shown = escapeTraceString(value.slice(0, 15));
      return value.length > 15 ? `'${shown}...'` : `'${shown}'`;
    }
  }
  if (value instanceof PhpArray) return 'Array';
  return `Object(${(value as PhpObject).cls.name})`;
}

const TRACE_ESCAPES: Record<string, string> = {
  '\n': 'n',
  '\r': 'r',
  '\t': 't',
  '\f': 'f',
  '\v': 'v',
  '\\': '\\',
  '\u001B': 'e',
};

/** Escapes the bytes of a string argument in a stack trace as PHP's smart_str_append_escaped does. */
function escapeTraceString(text: string): string {
  return text.replaceAll(/[\0-\u001F\\\u007F-\u00FF]/g, (char) => {
    const escape = TRACE_ESCAPES[char];
    return `\\${escape ?? `x${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(2, '0')}`}`;
  });
}

/** The text of a throwable as `__toString` gives it, which an uncaught exception prints. */
export function throwableText(object: PhpObject): string {
  const method = object.cls.findMethod('__tostring');
  const text =
    method?.fn.kind === 'user'
      ? asInternal(() => toStr(callMethod(object, '__toString', [])))
      : defaultThrowableText(object);
  return storeThrowableText(object, text);
}

function storeThrowableText(object: PhpObject, text: string): string {
  object.props.set(throwableKey(object, 'string'), text);
  return text;
}

function defaultThrowableText(object: PhpObject): string {
  const runtime = rt();
  const chain = new Set<PhpObject>();
  for (let current: Value = object; current instanceof PhpObject && !chain.has(current);) {
    runtime.spend();
    chain.add(current);
    current = slotValue(current, throwableKey(current, 'previous'));
  }
  const parts: string[] = [];
  let length = 0;
  for (const item of [...chain].toReversed()) {
    const message = describedMessage(item);
    const header = message === '' ? item.cls.name : `${item.cls.name}: ${message}`;
    const line = slotValue(item, 'line');
    const text = `${header} in ${toStr(slotValue(item, 'file'))}:${toStr(line)}\nStack trace:\n${traceArrayText(slotValue(item, throwableKey(item, 'trace')))}`;
    length += text.length + (parts.length > 0 ? '\n\nNext '.length : 0);
    runtime.ensureStringFits(length);
    parts.push(text);
  }
  return parts.join('\n\nNext ');
}

/** The message as `__toString` writes it, which names where PHP declared the function an argument error is about. */
function describedMessage(object: PhpObject): string {
  const message = toStr(slotValue(object, 'message'));
  const exact = object.cls.name === 'TypeError' || object.cls.name === 'ArgumentCountError';
  return exact && message.includes(', called in ') ? `${message} and defined` : message;
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
  runtime.activeErrorHandlers.add(handler);
  try {
    const result = callValue(
      handler,
      [{ v: level }, { v: message }, { v: SCRIPT_PATH }, { v: BigInt(row + 1) }],
      undefined
    );
    return result !== false;
  } finally {
    runtime.activeErrorHandlers.delete(handler);
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
  {
    signature: '__toString(): string',
    impl: ({ thisObj }) => storeThrowableText(thisObj, defaultThrowableText(thisObj)),
  },
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

setThrowableFormatter(throwableText);
