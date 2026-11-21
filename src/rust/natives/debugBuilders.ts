import { indentDebug, type WriteChunk } from '../debugText';
import { DEFAULT_SPEC } from '../fmt';
import { FmtFailure } from '../runtime';
import type { Type } from '../types';
import {
  DONE,
  type DynValue,
  type FormatterValue,
  type IterValue,
  StructValue,
  textOf,
  UNIT_VALUE,
  type Value,
} from '../values';
import { nextOf } from './iterators';
import { define, deref, err, type NativeContext, ok } from './support';

const DELIMITERS = {
  struct: [' {', '}'],
  tuple: ['(', ')'],
  list: ['[', ']'],
  set: ['{', '}'],
  map: ['{', '}'],
};

interface DebugBuilder {
  formatter: FormatterValue;
  kind: keyof typeof DELIMITERS;
  entries: number;
  unnamed: boolean;
  failed: boolean;
}

define({
  'Formatter::debug_struct': start('struct'),
  'Formatter::debug_tuple': start('tuple'),
  'Formatter::debug_list': start('list'),
  'Formatter::debug_set': start('set'),
  'Formatter::debug_map': start('map'),
  'DebugStruct::field': ([self, name, value], ctx) =>
    add(self, (b, write) => {
      write(textOf(name));
      write(': ');
      debugDyn(ctx, b, value, write);
    }),
  'DebugStruct::finish': finish(),
  'DebugStruct::finish_non_exhaustive': finish(true),
  'DebugTuple::field': ([self, value], ctx) => add(self, (b, write) => debugDyn(ctx, b, value, write)),
  'DebugTuple::finish': finish(),
  'DebugList::entry': ([self, value], ctx) => add(self, (b, write) => debugDyn(ctx, b, value, write)),
  'DebugList::entries': ([self, iter], ctx) => addEntries(ctx, self, iter, false),
  'DebugList::finish': finish(),
  'DebugSet::entry': ([self, value], ctx) => add(self, (b, write) => debugDyn(ctx, b, value, write)),
  'DebugSet::entries': ([self, iter], ctx) => addEntries(ctx, self, iter, false),
  'DebugSet::finish': finish(),
  'DebugMap::entry': ([self, key, value], ctx) =>
    add(self, (b, write) => {
      debugDyn(ctx, b, key, write);
      write(': ');
      debugDyn(ctx, b, value, write);
    }),
  'DebugMap::entries': ([self, iter], ctx) => addEntries(ctx, self, iter, true),
  'DebugMap::finish': finish(),
});

function start(kind: DebugBuilder['kind']): (args: Value[]) => Value {
  return ([self, name]) => {
    const formatter = deref(self) as FormatterValue;
    const label = name === undefined ? DELIMITERS[kind][0] : textOf(name);
    formatter.write(label);
    return { formatter, kind, entries: 0, unnamed: label === '', failed: false } as never;
  };
}

function add(self: Value, entry: (builder: DebugBuilder, write: WriteChunk) => void): Value {
  const b = deref(self) as unknown as DebugBuilder;
  if (b.failed) return self;
  const write = (text: string): void => b.formatter.write(text);
  const pretty = b.formatter.spec.alternate;
  if (b.entries === 0) {
    if (b.kind === 'struct' || b.kind === 'tuple') write(DELIMITERS[b.kind][0]);
    if (pretty) write('\n');
    else if (b.kind === 'struct') write(' ');
  } else if (!pretty) write(', ');
  const writeEntry = pretty ? indentDebug(write, 1, true) : write;
  b.entries++;
  try {
    entry(b, writeEntry);
    if (pretty) writeEntry(',\n');
  } catch (error) {
    if (!(error instanceof FmtFailure)) throw error;
    b.failed = true;
  }
  return self;
}

function addEntries(ctx: NativeContext, self: Value, iter: Value, pairs: boolean): Value {
  const it = deref(iter) as IterValue;
  for (let item = nextOf(it); item !== DONE; item = nextOf(it)) {
    ctx.runtime.spend();
    const value = item;
    ctx.runtime.withRoots([value], () =>
      add(self, (b, write) => {
        if (pairs) {
          const [key, item] = deref(value) as Value[];
          debugValue(ctx, b, key, ctx.typeArgs[0], write);
          write(': ');
          debugValue(ctx, b, item, ctx.typeArgs[1], write);
        } else debugValue(ctx, b, value, ctx.typeArgs[0], write);
      })
    );
  }
  return self;
}

function debugDyn(ctx: NativeContext, b: DebugBuilder, value: Value, write: WriteChunk): void {
  const dyn = deref(value) as DynValue;
  debugValue(ctx, b, dyn.value, dyn.type, write);
}

function debugValue(ctx: NativeContext, b: DebugBuilder, value: Value, type: Type, write: WriteChunk): void {
  const { spec } = b.formatter;
  ctx.interp.formatter.debug(value, type, { ...DEFAULT_SPEC, ...spec }, spec.alternate ? 0 : undefined, write);
}

function finish(nonExhaustive = false): (args: Value[], ctx: NativeContext) => Value {
  return ([self], ctx) => {
    const b = deref(self) as unknown as DebugBuilder;
    if (b.failed) return err(ctx, new StructValue(ctx.interp.program.adtDef('FmtError'), []));
    b.formatter.write(ending(b, nonExhaustive));
    return ok(ctx, UNIT_VALUE);
  };
}

function ending(b: DebugBuilder, nonExhaustive: boolean): string {
  const pretty = b.formatter.spec.alternate;
  if (b.kind === 'struct') return structEnding(b.entries, pretty, nonExhaustive);
  if (b.kind === 'tuple') {
    if (b.entries === 0) return '';
    if (b.unnamed && b.entries === 1 && !pretty) return ',)';
  }
  return DELIMITERS[b.kind][1];
}

function structEnding(entries: number, pretty: boolean, nonExhaustive: boolean): string {
  if (entries === 0) return nonExhaustive ? ' { .. }' : '';
  if (pretty) return nonExhaustive ? '    ..\n}' : '}';
  return nonExhaustive ? ', .. }' : ' }';
}
