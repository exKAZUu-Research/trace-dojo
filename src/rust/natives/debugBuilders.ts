import { DEFAULT_SPEC } from '../fmt';
import { type DynValue, type FormatterValue, UNIT_VALUE, type Value } from '../values';
import { define, deref, type NativeContext, ok } from './support';

/** What `Formatter::debug_struct` and its kin build: the entries written so far, each formatted when added. */
interface DebugBuilder {
  formatter: FormatterValue;
  kind: 'struct' | 'tuple' | 'list' | 'set' | 'map';
  name: string;
  entries: string[];
}

function builder(self: Value): DebugBuilder {
  return deref(self) as unknown as DebugBuilder;
}

function start(kind: DebugBuilder['kind']): (args: Value[]) => Value {
  return ([self, name]) =>
    ({ formatter: deref(self) as FormatterValue, kind, name: (name && deref(name)) ?? '', entries: [] }) as never;
}

/** A `&dyn Debug` entry, nested one level deeper than the builder in `{:#?}`. */
function entryText(ctx: NativeContext, b: DebugBuilder, value: Value): string {
  const dyn = deref(value) as DynValue;
  const { spec } = b.formatter;
  return ctx.interp.formatter.debug(dyn.value, dyn.type, { ...DEFAULT_SPEC, ...spec }, spec.alternate ? 1 : undefined);
}

function add(
  text: (args: Value[], ctx: NativeContext, b: DebugBuilder) => string
): (args: Value[], ctx: NativeContext) => Value {
  return (args, ctx) => {
    const b = builder(args[0]);
    b.entries.push(text(args, ctx, b));
    return args[0];
  };
}

const BRACKETS: Record<DebugBuilder['kind'], [string, string]> = {
  struct: [' {', '}'],
  tuple: ['(', ')'],
  list: ['[', ']'],
  set: ['{', '}'],
  map: ['{', '}'],
};

/** Writes what the builder holds as std's builders do: `Name { a: 1 }`, or one entry per line in `{:#?}`. */
function finish(nonExhaustive: boolean): (args: Value[], ctx: NativeContext) => Value {
  return ([self], ctx) => {
    const b = builder(self);
    b.formatter.text += b.name + body(b, nonExhaustive);
    return ok(ctx, UNIT_VALUE);
  };
}

function body(b: DebugBuilder, nonExhaustive: boolean): string {
  const [open, close] = BRACKETS[b.kind];
  if (b.entries.length === 0) {
    if (nonExhaustive) return ' { .. }';
    return b.kind === 'struct' || b.kind === 'tuple' ? '' : `${open}${close}`;
  }
  if (b.formatter.spec.alternate) {
    const lines = b.entries.map((entry) => `    ${entry},\n`).join('');
    return `${open}\n${lines}${nonExhaustive ? '    ..\n' : ''}${close}`;
  }
  const entries = nonExhaustive ? [...b.entries, '..'] : b.entries;
  const padding = b.kind === 'struct' ? ' ' : '';
  return `${open}${padding}${entries.join(', ')}${padding}${close}`;
}

define({
  'Formatter::debug_struct': start('struct'),
  'Formatter::debug_tuple': start('tuple'),
  'Formatter::debug_list': start('list'),
  'Formatter::debug_set': start('set'),
  'Formatter::debug_map': start('map'),
  'DebugStruct::field': add(([, name, value], ctx, b) => `${deref(name) as string}: ${entryText(ctx, b, value)}`),
  'DebugStruct::finish': finish(false),
  'DebugStruct::finish_non_exhaustive': finish(true),
  'DebugTuple::field': add(([, value], ctx, b) => entryText(ctx, b, value)),
  'DebugTuple::finish': finish(false),
  'DebugList::entry': add(([, value], ctx, b) => entryText(ctx, b, value)),
  'DebugList::finish': finish(false),
  'DebugSet::entry': add(([, value], ctx, b) => entryText(ctx, b, value)),
  'DebugSet::finish': finish(false),
  'DebugMap::entry': add(([, key, value], ctx, b) => `${entryText(ctx, b, key)}: ${entryText(ctx, b, value)}`),
  'DebugMap::finish': finish(false),
});
