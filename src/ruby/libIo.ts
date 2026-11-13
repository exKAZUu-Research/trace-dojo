import type { OutputChannel } from '../interpreter/programIo';
import { inspect, toInt, toS, toSValue } from './conversions';
import { def } from './define';
import { typeError } from './errors';
import { format, formatString } from './format';
import { callMethod, type Gen, respondsTo } from './interp';
import { NIL, RArray, RObject, RString, type Value, type Visibility } from './objects';
import { prettyInspect } from './prettyPrint';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, realClassOf, str, stringBytes } from './values';

const PRIVATE = { visibility: 'private' as Visibility };

/** Writes each puts value as it is visited, bounding recursive output. */
function* writePuts(target: Value, args: Value[]): Gen<void> {
  if (args.length === 0) {
    yield* write(target, '\n');
    return;
  }
  const visit = function* (value: Value, seen: Set<RArray>): Gen<void> {
    rt().spend();
    let array = value instanceof RArray ? value : undefined;
    if (!array && respondsTo(value, 'to_ary')) {
      const converted = yield* callMethod(value, 'to_ary', []);
      if (converted instanceof RArray) array = converted;
      else if (converted !== NIL) {
        throw typeError(
          `can't convert ${realClassOf(value).name} to Array (${realClassOf(value).name}#to_ary gives ${realClassOf(converted).name})`
        );
      }
    }
    if (array) {
      if (seen.has(array)) {
        yield* write(target, '[...]\n');
        return;
      }
      seen.add(array);
      try {
        for (const item of array.items) yield* visit(item, seen);
      } finally {
        seen.delete(array);
      }
      return;
    }
    const line = value instanceof RString ? value.s : yield* toS(value);
    yield* write(target, line.endsWith('\n') ? line : `${line}\n`);
  };
  for (const arg of args) yield* visit(arg, new Set());
}

function* write(target: Value, text: string): Gen<void> {
  if (target instanceof RObject && (target.data === 'stdout' || target.data === 'stderr')) {
    channel(target.data).write(text);
    return;
  }
  yield* callMethod(target, 'write', [str(text)]);
}

function channel(stream: 'stdout' | 'stderr'): OutputChannel {
  return rt().io[stream];
}

function stdout(): Value {
  return rt().globals.get('$stdout') ?? NIL;
}

def(
  'Kernel',
  'puts',
  [0, -1],
  function* (_self, args) {
    yield* writePuts(stdout(), args);
    return NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  'print',
  [0, -1],
  function* (_self, args) {
    for (const arg of args) yield* write(stdout(), yield* toS(arg));
    return NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  'p',
  [0, -1],
  function* (_self, args) {
    for (const arg of args) yield* write(stdout(), `${yield* inspect(arg)}\n`);
    if (args.length === 0) return NIL;
    return args.length === 1 ? args[0] : arr(args);
  },
  PRIVATE
);
def(
  'Kernel',
  'pp',
  [0, -1],
  function* (_self, args) {
    for (const arg of args) yield* write(stdout(), yield* prettyInspect(arg));
    if (args.length === 0) return NIL;
    return args.length === 1 ? args[0] : arr(args);
  },
  PRIVATE
);
def(
  'Kernel',
  'printf',
  [0, -1],
  function* (_self, args) {
    if (args.length === 0) return NIL;
    yield* write(stdout(), yield* format(args[0], args.slice(1)));
    return NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  ['format', 'sprintf'],
  [1, -1],
  function* (_self, args) {
    return yield* formatString(args[0], args.slice(1));
  },
  PRIVATE
);
def(
  'Kernel',
  'putc',
  1,
  function* (_self, [value]) {
    yield* write(stdout(), yield* charOf(value));
    return value;
  },
  PRIVATE
);
def(
  'Kernel',
  'warn',
  [0, -1],
  function* (_self, args, _block, keywords) {
    void keywords;
    if (args.length > 0) yield* writePuts(rt().globals.get('$stderr') ?? NIL, args);
    return NIL;
  },
  { ...PRIVATE, keywords: true }
);

function* charOf(value: Value): Gen<string> {
  if (value instanceof RString)
    return value.s.slice(0, value.s.codePointAt(0) && value.s.codePointAt(0)! > 0xff_ff ? 2 : 1);
  return String.fromCodePoint(Number((yield* toInt(value)) & 0xffn));
}

// $stdout and $stderr ----------------------------------------------------------------------------------------------

def('IO', 'puts', [0, -1], function* (self: RObject, args) {
  yield* writePuts(self, args);
  return NIL;
});
def('IO', 'print', [0, -1], function* (self: RObject, args) {
  for (const arg of args) yield* write(self, yield* toS(arg));
  return NIL;
});
def('IO', 'write', [0, -1], function* (self: RObject, args) {
  let bytes = 0n;
  for (const arg of args) {
    const value = yield* toSValue(arg);
    channel(self.data as 'stdout' | 'stderr').write(value.s);
    bytes += BigInt(stringBytes(value).length);
  }
  return bytes;
});
def('IO', '<<', 1, function* (self: RObject, [value]) {
  yield* write(self, yield* toS(value));
  return self;
});
def('IO', 'printf', [1, -1], function* (self: RObject, args) {
  yield* write(self, yield* format(args[0], args.slice(1)));
  return NIL;
});
def('IO', 'p', [0, -1], function* (self: RObject, args) {
  for (const arg of args) yield* write(self, `${yield* inspect(arg)}\n`);
  return args.length === 0 ? NIL : args.length === 1 ? args[0] : arr(args);
});
def('IO', 'putc', 1, function* (self: RObject, [value]) {
  yield* write(self, yield* charOf(value));
  return value;
});
def('IO', ['flush', 'fsync'], 0, (self) => self);
def('IO', 'sync', 0, () => true);
def('IO', 'sync=', 1, (_self, [value]) => value);
def('IO', 'tty?', 0, () => false);
def('IO', 'isatty', 0, () => false);
def('IO', 'fileno', 0, (self: RObject) => (self.data === 'stdout' ? 1n : 2n));
def('IO', 'inspect', 0, (self: RObject) => str(`#<IO:<${self.data === 'stdout' ? 'STDOUT' : 'STDERR'}>>`));
for (const name of ['gets', 'read', 'readline', 'readlines', 'each_line', 'getc', 'close', 'reopen']) {
  def('IO', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`IO#${name}`);
  });
}

export { respondsTo };
