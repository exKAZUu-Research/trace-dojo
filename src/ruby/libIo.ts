import type { OutputChannel } from '../interpreter/programIo';
import { inspect, inspectValue, toInt, toSValue } from './conversions';
import { def } from './define';
import { argumentError, typeError } from './errors';
import { exportBinaryInspect, formatString } from './format';
import { callMethod, type Gen, respondsTo } from './interp';
import { NIL, RArray, RObject, RString, type Value, type Visibility } from './objects';
import { writePretty } from './prettyPrint';
import { rt, UnsupportedFeatureError, whileHeld } from './runtime';
import { arr, classOf, realClassOf, str, stringBytes, stringCharacters, stringFromBytes } from './values';

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
    if (!array && respondsTo(value, 'to_ary', true)) {
      const converted = yield* callMethod(value, 'to_ary', [], undefined, undefined, { fcall: true });
      if (converted instanceof RArray) array = converted;
      else if (converted !== NIL) {
        throw typeError(
          `can't convert ${realClassOf(value).name} to Array (${realClassOf(value).name}#to_ary gives ${realClassOf(converted).name})`
        );
      }
    }
    if (array) {
      if (seen.has(array)) {
        yield* write(target, '[...]');
        yield* write(target, '\n');
        return;
      }
      return yield* whileHeld(array, function* () {
        seen.add(array);
        try {
          for (let index = 0; index < array.items.length; index++) yield* visit(array.items[index], seen);
        } finally {
          seen.delete(array);
        }
      });
    }
    const line = value instanceof RString ? value : yield* toSValue(value);
    const needsNewline = !line.s.endsWith('\n');
    if (line.s.length > 0) yield* write(target, line);
    if (needsNewline) yield* write(target, '\n');
  };
  for (const arg of args) yield* visit(arg, new Set());
}

function* writePrint(target: Value, args: Value[]): Gen<void> {
  const values = args.length > 0 ? args : [rt().frame.home.scope.vars.get('$_') ?? NIL];
  for (const [index, arg] of values.entries()) {
    const field = rt().globals.get('$,') ?? NIL;
    if (index > 0 && field !== NIL) yield* write(target, field);
    yield* write(target, arg);
  }
  const record = rt().globals.get('$\\') ?? NIL;
  if (record !== NIL) yield* write(target, record);
}

function* write(target: Value, value: string | Value): Gen<void> {
  const text = typeof value === 'string' ? str(value) : value;
  if (target instanceof RObject && (target.data === 'stdout' || target.data === 'stderr')) {
    channel(target.data).write((text instanceof RString ? text : yield* toSValue(text)).s);
    return;
  }
  yield* callMethod(target, 'write', [text]);
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
    yield* writePrint(stdout(), args);
    return NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  'p',
  [0, -1],
  function* (_self, args) {
    for (const arg of args) {
      const inspected = yield* inspectValue(arg);
      const target = stdout();
      yield* write(target, inspected.binary ? exportBinaryInspect(inspected) : inspected);
      yield* write(target, '\n');
    }
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
    for (const arg of args) {
      const target = stdout();
      yield* writePretty(arg, (part) => write(target, part));
    }
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
    const explicit = !(args[0] instanceof RString);
    if (explicit && args.length < 2) throw argumentError('too few arguments');
    yield* write(
      explicit ? args[0] : stdout(),
      yield* formatString(args[Number(explicit)], args.slice(explicit ? 2 : 1))
    );
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
    const target = stdout();
    const putc = classOf(target).findMethod('putc');
    if (putc && putc.owner !== rt().c.Kernel) {
      return yield* callMethod(target, 'putc', [value], undefined, undefined, { fcall: true });
    }
    yield* write(target, yield* charOf(value));
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

function* charOf(value: Value): Gen<RString> {
  if (value instanceof RString) return stringCharacters(value)[0] ?? str('');
  return stringFromBytes(Uint8Array.of(Number((yield* toInt(value)) & 0xffn)), true);
}

// $stdout and $stderr ----------------------------------------------------------------------------------------------

def('IO', 'puts', [0, -1], function* (self: RObject, args) {
  yield* writePuts(self, args);
  return NIL;
});
def('IO', 'print', [0, -1], function* (self: RObject, args) {
  yield* writePrint(self, args);
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
  yield* write(self, yield* toSValue(value));
  return self;
});
def('IO', 'printf', [1, -1], function* (self: RObject, args) {
  yield* write(self, yield* formatString(args[0], args.slice(1)));
  return NIL;
});
def('IO', 'p', [0, -1], function* (self: RObject, args) {
  for (const arg of args) {
    yield* write(self, yield* inspect(arg));
    yield* write(self, '\n');
  }
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
