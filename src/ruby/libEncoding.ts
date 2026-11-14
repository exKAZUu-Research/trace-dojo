import { def } from './define';
import { callProc, type Gen, requireBlock } from './interp';
import { NIL, RObject, type RString, type Value } from './objects';
import { ExitSignal, rt, RubyError, type Runtime } from './runtime';
import { arr, str } from './values';

/** Creates the encodings a program can name: strings here are UTF-8, or ASCII-8BIT when they hold bytes. */
export function installEncodings(runtime: Runtime): void {
  const encoding = runtime.c.Encoding;
  for (const [constant, name] of [
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Ruby names the encoding this way.
    ['UTF_8', 'UTF-8'],
    ['ASCII_8BIT', 'ASCII-8BIT'],
    ['BINARY', 'ASCII-8BIT'],
    ['US_ASCII', 'US-ASCII'],
  ] as const) {
    const existing = [...encoding.constants.values()].find((value) => value instanceof RObject && value.data === name);
    if (existing) {
      encoding.constants.set(constant, existing);
      continue;
    }
    const object = new RObject(encoding);
    object.data = name;
    encoding.constants.set(constant, object);
  }
}

def('Encoding', ['to_s', 'name'], 0, (self: RObject) => str(self.data as string));
def('Encoding', 'inspect', 0, (self: RObject) =>
  str(`#<Encoding:${self.data as string}${self.data === 'ASCII-8BIT' ? ' (BINARY)' : ''}>`)
);
def(
  'String',
  'encoding',
  0,
  (self: RString) => rt().c.Encoding.constants.get(self.binary ? 'ASCII_8BIT' : 'UTF_8') as Value
);
def('String', 'valid_encoding?', 0, () => true);

def(
  'Kernel',
  'at_exit',
  0,
  (_self, _args, block) => {
    const proc = requireBlock(block);
    rt().atExit.push(proc);
    return proc;
  },
  { visibility: 'private' }
);

/** Runs the blocks `at_exit` and `END` registered, the last registered first. */
export function* runAtExit(): Gen<void> {
  const runtime = rt();
  let pending: RubyError | ExitSignal | undefined;
  while (runtime.atExit.length > 0) {
    try {
      yield* callProc(runtime.atExit.pop() as never, []);
    } catch (error) {
      if (error instanceof RubyError) runtime.globals.set('$!', error.exception);
      else if (!(error instanceof ExitSignal)) throw error;
      pending = error;
    }
  }
  if (pending) throw pending;
}

/** The text after `__END__`, which `DATA` reads as a file opened at its start. */
export function makeData(text: string): RObject {
  const data = new RObject(rt().c.File);
  data.data = { text, position: 0 };
  return data;
}

interface DataState {
  text: string;
  position: number;
}

function remaining(self: RObject): string {
  const state = self.data as DataState;
  return state.text.slice(state.position);
}

def('File', 'read', 0, (self: RObject) => {
  const text = remaining(self);
  (self.data as DataState).position = (self.data as DataState).text.length;
  return str(text);
});
def('File', 'gets', 0, (self: RObject) => {
  const state = self.data as DataState;
  if (state.position >= state.text.length) return NIL;
  const end = state.text.indexOf('\n', state.position);
  const line = state.text.slice(state.position, end === -1 ? undefined : end + 1);
  state.position += line.length;
  return str(line);
});
def('File', 'readlines', 0, (self: RObject) => {
  const lines = remaining(self)
    .split(/(?<=\n)/)
    .filter((line) => line.length > 0);
  (self.data as DataState).position = (self.data as DataState).text.length;
  return arr(lines.map((line) => str(line)));
});
def('File', 'each_line', 0, function* (self: RObject, _args, block) {
  const lines = remaining(self)
    .split(/(?<=\n)/)
    .filter((line) => line.length > 0);
  (self.data as DataState).position = (self.data as DataState).text.length;
  for (const line of lines) yield* callProc(requireBlock(block), [str(line)], { used: false });
  return self;
});
def('File', 'rewind', 0, (self: RObject) => {
  (self.data as DataState).position = 0;
  return 0n;
});
def('File', 'eof?', 0, (self: RObject) => remaining(self).length === 0);
