import type { OutputChannel } from '../interpreter/programIo';
import { inspect, toInt, toS } from './conversions';
import { def } from './define';
import { format } from './format';
import { callMethod, type Gen, respondsTo } from './interp';
import { NIL, RArray, RObject, RString, type Value, type Visibility } from './objects';
import { prettyInspect } from './prettyPrint';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, str } from './values';

const PRIVATE = { visibility: 'private' as Visibility };

/** The text `puts` writes for its arguments: each on its own line, arrays flattened, nil as an empty line. */
export function* putsText(args: Value[]): Gen<string> {
  if (args.length === 0) return '\n';
  let text = '';
  const visit = function* (value: Value, seen: Set<RArray>): Gen<void> {
    if (value instanceof RArray) {
      if (seen.has(value)) {
        text += '[...]\n';
        return;
      }
      if (value.items.length === 0 && seen.size === 0) {
        text += '\n';
        return;
      }
      seen.add(value);
      for (const item of value.items) yield* visit(item, seen);
      seen.delete(value);
      return;
    }
    const line = value instanceof RString ? value.s : yield* toS(value);
    text += line.endsWith('\n') ? line : `${line}\n`;
  };
  for (const arg of args) yield* visit(arg, new Set());
  return text;
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
    yield* write(stdout(), yield* putsText(args));
    return NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  'print',
  [0, -1],
  function* (_self, args) {
    let text = '';
    for (const arg of args) text += yield* toS(arg);
    yield* write(stdout(), text);
    return NIL;
  },
  PRIVATE
);
def(
  'Kernel',
  'p',
  [0, -1],
  function* (_self, args) {
    let text = '';
    for (const arg of args) text += `${yield* inspect(arg)}\n`;
    yield* write(stdout(), text);
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
    let text = '';
    for (const arg of args) text += yield* prettyInspect(arg);
    yield* write(stdout(), text);
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
    return str(yield* format(args[0], args.slice(1)));
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
    if (args.length > 0) channel('stderr').write(yield* putsText(args));
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
  yield* write(self, yield* putsText(args));
  return NIL;
});
def('IO', 'print', [0, -1], function* (self: RObject, args) {
  let text = '';
  for (const arg of args) text += yield* toS(arg);
  yield* write(self, text);
  return NIL;
});
def('IO', 'write', [0, -1], function* (self: RObject, args) {
  let text = '';
  for (const arg of args) text += yield* toS(arg);
  channel(self.data as 'stdout' | 'stderr').write(text);
  return BigInt(new TextEncoder().encode(text).length);
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
  let text = '';
  for (const arg of args) text += `${yield* inspect(arg)}\n`;
  yield* write(self, text);
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
