import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  addressOf,
  className,
  inspect,
  rEql,
  rEquals,
  rubyEncodingName,
  supportsImplicitConversion,
  symInspect,
  toIndex,
  toIndexExact,
  toInt,
  toStrValue,
  tryImplicitConversion,
} from './conversions';
import { def, sdef, sundef } from './define';
import { argumentError, frozenError, indexError, nameError, rubyError, typeError } from './errors';
import { digest, hashKeyOf, hashSet } from './hashes';
import { addMethod, assertMutableClass, callBlock, callMethod, callProc, type Gen, invoke } from './interp';
import { tryAry } from './libArray';
import { sizedEnumerator } from './libEnumerator';
import { symbolNameOf } from './libMeta';
import { NIL, RArray, RClass, type RHash, RObject, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import {
  arr,
  newHash,
  range,
  realClassOf,
  singletonClassOf,
  str,
  stringBytes,
  stringFromBytes,
  truthy,
} from './values';

/** The members of a Struct or Data class, and whether its `new` takes keywords only. */
interface Layout {
  members: string[];
  memberSymbols: RSymbol[];
  keywordInit: boolean | undefined;
  kind: 'struct' | 'data';
}

const layouts = new WeakMap<RClass, Layout>();

export function copyStructLayout(source: RClass, copy: RClass): void {
  const layout = layouts.get(source);
  if (layout) layouts.set(copy, { ...layout, members: [...layout.members], memberSymbols: [...layout.memberSymbols] });
}

function layoutOf(cls: RClass): Layout {
  const layout = layoutFor(cls);
  if (layout) return layout;
  throw typeError('not a struct');
}

function layoutFor(cls: RClass): Layout | undefined {
  for (let current: RClass | undefined = cls; current; current = current.superclass) {
    const layout = layouts.get(current);
    if (layout) return layout;
  }
  return undefined;
}

class StructValues {
  constructor(readonly values: Value[]) {}

  held(): Value[] {
    return this.values;
  }

  copy(): StructValues {
    return new StructValues([...this.values]);
  }

  /** The values whose keys make the struct's key in a Hash, with its class's. */
  hashParts(): Value[] {
    return this.values;
  }
}

function valuesOf(self: RObject): Value[] {
  return (self.data as StructValues).values;
}

export function structEntriesOf(value: RObject): [string, Value][] | undefined {
  const data = value.data;
  if (!(data instanceof StructValues)) return undefined;
  return layoutOf(value.cls).members.map((name, index) => [name, data.values[index]]);
}

function* memberIndex(self: RObject, key: Value): Gen<number> {
  const { members, memberSymbols } = layoutOf(self.cls);
  if (key instanceof RSymbol || key instanceof RString) {
    const name = key instanceof RSymbol ? key.name : key.s;
    const symbol = key instanceof RSymbol ? key : RSymbol.of(key.s, key.binary, key.usAscii, stringBytes(key));
    const index = memberSymbols.indexOf(symbol);
    if (index === -1) {
      throw nameError(`no member '${name}' in struct`, self, name);
    }
    return index;
  }
  const raw = yield* toIndex(key);
  let index = raw;
  if (index < 0) index += members.length;
  if (index < 0 || index >= members.length) {
    throw indexError(`offset ${raw} too ${raw < 0 ? 'small' : 'large'} for struct(size:${members.length})`);
  }
  return index;
}

function* membersFrom(args: Value[], kind: 'struct' | 'data'): Gen<RSymbol[]> {
  const members: RSymbol[] = [];
  for (const arg of args) {
    const member = yield* symbolNameOf(arg);
    const name = member.name;
    if (name.endsWith('=')) throw argumentError(`invalid ${kind} member: ${name}`);
    if (members.some((member) => member.name === name)) throw argumentError(`duplicate member: ${name}`);
    members.push(member);
  }
  return members;
}

function defineAccessors(cls: RClass, members: string[], writable: boolean): void {
  for (const [index, name] of members.entries()) {
    addMethod(cls, {
      name,
      owner: cls,
      visibility: 'public',
      body: { kind: 'native', fn: (self: RObject) => valuesOf(self)[index], min: 0, max: 0, takesKeywords: false },
    });
    if (!writable) continue;
    addMethod(cls, {
      name: `${name}=`,
      owner: cls,
      visibility: 'public',
      body: {
        kind: 'native',
        *fn(self: RObject, [value]) {
          if (self.frozen) throw frozenError(self, yield* inspect(self));
          valuesOf(self)[index] = value;
          return value;
        },
        min: 1,
        max: 1,
        takesKeywords: false,
      },
    });
  }
}

function* newStructClass(
  superclass: RClass,
  memberSymbols: RSymbol[],
  layout: Omit<Layout, 'members' | 'memberSymbols'>
): Gen<RClass> {
  const members = memberSymbols.map((member) => member.name);
  const cls = new RClass(rt().c.Class, undefined, superclass, false);
  cls.isUserDefined = true;
  layouts.set(cls, { ...layout, members, memberSymbols });
  defineAccessors(cls, members, layout.kind === 'struct');
  const singleton = singletonClassOf(cls);
  if (layout.kind === 'data')
    addMethod(singleton, { name: 'define', owner: singleton, visibility: 'public', body: { kind: 'undefined' } });
  for (const name of ['new', '[]']) {
    addMethod(singleton, {
      name,
      owner: singleton,
      visibility: 'public',
      body: {
        kind: 'native',
        fn: (self, args, block, keywords) =>
          layout.kind === 'data'
            ? constructData(self as RClass, args, block, keywords)
            : constructStruct(self as RClass, args, block, keywords),
        min: 0,
        max: -1,
        takesKeywords: true,
      },
    });
  }
  addMethod(singleton, {
    name: 'allocate',
    owner: singleton,
    visibility: 'public',
    body: {
      kind: 'native',
      fn: (self) => allocateStruct(self as RClass),
      min: 0,
      max: 0,
      takesKeywords: false,
    },
  });
  yield* [];
  return cls;
}

function allocateStruct(cls: RClass): RObject {
  const object = new RObject(cls);
  object.data = new StructValues(layoutOf(cls).members.map(() => NIL));
  return object;
}

for (const name of ['Struct', 'Data'])
  sdef(name, 'allocate', 0, () => {
    throw typeError(`allocator undefined for ${name}`);
  });

function* constructStruct(self: RClass, args: Value[], block: RProc | undefined, keywords?: RHash): Gen<RObject> {
  const object = allocateStruct(self);
  const initialize = self.findMethod('initialize');
  if (initialize) yield* invoke(initialize, object, args, keywords, block, false);
  return object;
}

// Struct ---------------------------------------------------------------------------------------------------------------

sdef(
  'Struct',
  'new',
  [0, -1],
  // code-gauge-allow functionCognitiveComplexity 19 -- Ruby's method takes these argument forms, which the branches mirror.
  function* (self: RClass, args, block, keywords) {
    const first = args[0];
    const classNameValue =
      first === undefined || first === NIL || first instanceof RSymbol ? undefined : yield* toStrValue(first);
    let keywordInit: boolean | undefined;
    if (keywords) {
      for (const entry of keywords.map.values()) {
        if (entry.key instanceof RSymbol && entry.key.name === 'keyword_init')
          keywordInit = entry.value === NIL ? undefined : truthy(entry.value);
        else throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
      }
    }
    const names = classNameValue || first === NIL ? args.slice(1) : args;
    const name = classNameValue?.s;
    if (name !== undefined) {
      if (!/^[\p{Lu}\p{Lt}][\p{L}\p{M}\p{N}_]*$/u.test(name))
        throw nameError(`identifier ${name} needs to be constant`);
      assertMutableClass(self);
    }
    const cls = yield* newStructClass(self, yield* membersFrom(names, 'struct'), { keywordInit, kind: 'struct' });
    if (name !== undefined) {
      cls.baseName = name;
      cls.lexicalParent = self;
      self.constants.set(name, cls);
    }
    if (block) yield* callProc(block, [cls], { self: cls, definee: cls });
    return cls;
  },
  { keywords: true }
);

def(
  'Struct',
  'initialize',
  [0, -1],
  // code-gauge-allow functionCognitiveComplexity 19 -- Ruby's method takes these argument forms, which the branches mirror.
  function* (self: RObject, args, _block, keywords) {
    if (self.frozen) throw frozenError(self, yield* inspect(self));
    const { members, memberSymbols, keywordInit } = layoutOf(self.cls);
    const values = valuesOf(self);
    const next: Value[] = members.map(() => NIL);
    if (keywordInit || (keywordInit === undefined && args.length === 0 && keywords)) {
      if (args.length > 0) throw argumentError(`wrong number of arguments (given ${args.length}, expected 0)`);
      const unknown: Uint8Array[] = [];
      let nonAsciiEncoding: string | undefined;
      let incompatibleEncodings: [string, string] | undefined;
      for (const entry of keywords?.map.values() ?? []) {
        const index = entry.key instanceof RSymbol ? memberSymbols.indexOf(entry.key) : -1;
        if (index !== -1) {
          next[index] = entry.value;
          continue;
        }
        const bytes =
          entry.key instanceof RSymbol
            ? (entry.key.bytes ?? new TextEncoder().encode(entry.key.name))
            : new TextEncoder().encode(yield* inspect(entry.key));
        if (bytes.some((byte) => byte >= 0x80)) {
          const encoding =
            entry.key instanceof RSymbol && entry.key.usAscii
              ? 'US-ASCII'
              : rubyEncodingName(entry.key instanceof RSymbol && entry.key.binary);
          if (nonAsciiEncoding && nonAsciiEncoding !== encoding) incompatibleEncodings ??= [nonAsciiEncoding, encoding];
          nonAsciiEncoding ??= encoding;
        }
        unknown.push(bytes);
      }
      values.splice(0, values.length, ...next);
      if (incompatibleEncodings)
        throw rubyError(
          rt().c['Encoding::CompatibilityError'],
          stringFromBytes(
            new TextEncoder().encode(
              `incompatible character encodings: ${incompatibleEncodings[0]} and ${incompatibleEncodings[1]}`
            ),
            true
          )
        );
      if (unknown.length > 0) {
        const prefix = new TextEncoder().encode('unknown keywords: ');
        const length =
          prefix.length + unknown.reduce((size, bytes) => size + bytes.length, 0) + 2 * (unknown.length - 1);
        rt().checkStringLength(length);
        const message = new Uint8Array(length);
        message.set(prefix);
        let offset = prefix.length;
        for (const [index, bytes] of unknown.entries()) {
          if (index > 0) {
            message.set([44, 32], offset);
            offset += 2;
          }
          message.set(bytes, offset);
          offset += bytes.length;
        }
        throw rubyError(rt().c.ArgumentError, stringFromBytes(message, true));
      }
      return NIL;
    }
    const all = keywords ? [...args, keywords] : args;
    if (all.length > members.length) throw argumentError('struct size differs');
    for (const [index, value] of all.entries()) next[index] = value;
    values.splice(0, values.length, ...next);
    return NIL;
  },
  { visibility: 'private', keywords: true }
);
sdef('Struct', 'members', 0, (self: RClass) => arr([...layoutOf(self).memberSymbols]));
sdef('Struct', 'keyword_init?', 0, (self: RClass) => layoutOf(self).keywordInit ?? NIL);
sdef('Struct', 'inspect', 0, (self: RClass) =>
  str(`${className(self)}${layoutFor(self)?.keywordInit === true ? '(keyword_init: true)' : ''}`)
);
def('Struct', 'members', 0, (self: RObject) => arr([...layoutOf(self.cls).memberSymbols]));
def('Struct', ['to_a', 'deconstruct', 'values'], 0, (self: RObject) => arr([...valuesOf(self)]));
def('Struct', 'values_at', [0, -1], function* (self: RObject, args) {
  const values = valuesOf(self);
  const selected: Value[] = [];
  rt().heldArrays.push(selected);
  try {
    for (const argument of args) {
      if (argument instanceof RRange) {
        const begin = argument.begin === NIL ? NIL : (yield* toIndexExact(argument.begin)).integer;
        const end = argument.end === NIL ? NIL : (yield* toIndexExact(argument.end)).integer;
        const expanded = (yield* callMethod(arr([...values]), 'values_at', [
          range(begin, end, argument.exclusive),
        ])) as RArray;
        selected.push(...expanded.items);
        continue;
      }
      const index = yield* toInt(argument);
      if (index < -BigInt(values.length))
        throw indexError(`offset ${index} too small for struct(size:${values.length})`);
      if (index >= BigInt(values.length))
        throw indexError(`offset ${index} too large for struct(size:${values.length})`);
      selected.push(values[Number(index < 0n ? index + BigInt(values.length) : index)]);
    }
    return arr(selected);
  } finally {
    rt().heldArrays.pop();
  }
});
def('Struct', 'to_h', 0, (self: RObject, _args, block) => structToHash(self, block));
def('Struct', 'deconstruct_keys', 1, (self: RObject, [keys]) => deconstructKeys(self, keys));
def('Struct', '[]', 1, function* (self: RObject, [key]) {
  return valuesOf(self)[yield* memberIndex(self, key)];
});
def('Struct', '[]=', 2, function* (self: RObject, [key, value]) {
  const index = yield* memberIndex(self, key);
  if (self.frozen) throw frozenError(self, yield* inspect(self));
  valuesOf(self)[index] = value;
  return value;
});
def('Struct', ['each'], 0, function* (self: RObject, _args, block) {
  if (!block) return sizedEnumerator(self, 'each', [], () => BigInt(layoutOf(self.cls).members.length));
  for (let index = 0; index < valuesOf(self).length; index++) yield* callBlock(block, [valuesOf(self)[index]], false);
  return self;
});
def('Struct', 'each_pair', 0, function* (self: RObject, _args, block) {
  if (!block) return sizedEnumerator(self, 'each_pair', [], () => BigInt(layoutOf(self.cls).members.length));
  for (const [index, name] of layoutOf(self.cls).memberSymbols.entries()) {
    yield* callBlock(block, [arr([name, valuesOf(self)[index]])], false);
  }
  return self;
});
def('Struct', ['size', 'length'], 0, (self: RObject) => BigInt(valuesOf(self).length));
def('Struct', 'dig', [1, -1], function* (self: RObject, args) {
  const { members, memberSymbols } = layoutOf(self.cls);
  const key = args[0];
  let index: number;
  if (key instanceof RSymbol || key instanceof RString)
    index = memberSymbols.indexOf(
      key instanceof RSymbol ? key : RSymbol.of(key.s, key.binary, key.usAscii, stringBytes(key))
    );
  else {
    index = yield* toIndex(key);
    if (index < 0) index += members.length;
  }
  if (index < 0 || index >= members.length) return NIL;
  const value = valuesOf(self)[index];
  if (args.length === 1 || value === NIL) return value;
  if (!(yield* supportsImplicitConversion(value, 'dig')))
    throw typeError(`${realClassOf(value).name} does not have #dig method`);
  return yield* callMethod(value, 'dig', args.slice(1));
});
def('Struct', '==', 1, (self: RObject, [other]) => sameValues(self, other, rEquals));
def('Struct', 'eql?', 1, (self: RObject, [other]) => sameValues(self, other, rEql));
def('Struct', 'hash', 0, (self: RObject) => structuralHash(self));
def('Struct', ['inspect', 'to_s'], 0, (self: RObject) => inspectMembers(self, 'struct'));

function* sameValues(self: RObject, other: Value, equal: (a: Value, b: Value) => Gen<boolean>): Gen<boolean> {
  if (self === other) return true;
  if (!(other instanceof RObject) || realClassOf(other) !== realClassOf(self)) return false;
  const runtime = rt();
  const active = runtime.structComparisonPairs.get(self) ?? new Set<RObject>();
  if (active.has(other)) return true;
  if (runtime.structComparisonDepth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('output');
  runtime.structComparisonDepth++;
  active.add(other);
  runtime.structComparisonPairs.set(self, active);
  try {
    const left = valuesOf(self);
    const right = valuesOf(other);
    for (let index = 0; index < left.length; index++) if (!(yield* equal(left[index], right[index]))) return false;
    return true;
  } finally {
    runtime.structComparisonDepth--;
    active.delete(other);
    if (active.size === 0) runtime.structComparisonPairs.delete(self);
  }
}

function* structuralHash(self: RObject): Gen<bigint> {
  const runtime = rt();
  if (runtime.structHashing.has(self)) return 0n;
  if (runtime.structHashDepth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('output');
  runtime.structHashDepth++;
  runtime.structHashing.add(self);
  try {
    let classId = runtime.structClassHashIds.get(self.cls);
    if (classId === undefined) {
      classId = runtime.nextStructClassHashId++;
      runtime.structClassHashIds.set(self.cls, classId);
    }
    const parts: (number | string)[] = [classId];
    for (const value of valuesOf(self)) parts.push(yield* hashKeyOf(value));
    return BigInt(`0x${digest(JSON.stringify(parts))}`);
  } finally {
    runtime.structHashDepth--;
    runtime.structHashing.delete(self);
  }
}

const inspectingContexts = new WeakMap<object, Set<RObject>>();

function inspectingForContext(): Set<RObject> {
  const context = rt().activeCursor ?? rt();
  let inspecting = inspectingContexts.get(context);
  if (!inspecting) {
    inspecting = new Set<RObject>();
    inspectingContexts.set(context, inspecting);
  }
  return inspecting;
}

function* inspectMembers(self: RObject, kind: 'struct' | 'data'): Gen {
  const inspecting = inspectingForContext();
  const name = realClassOf(self).name;
  const head = name === undefined ? `#<${kind} ` : `#<${kind} ${name} `;
  if (inspecting.has(self)) return str(`${head.trimEnd()}:...>`);
  inspecting.add(self);
  try {
    const parts: string[] = [];
    let length = head.length + 1;
    for (const [index, member] of layoutOf(self.cls).members.entries()) {
      const value = yield* inspect(valuesOf(self)[index]);
      length += member.length + 1 + value.length + (parts.length > 0 ? 2 : 0);
      rt().checkStringLength(length);
      parts.push(`${member}=${value}`);
    }
    if (parts.length === 0) return str(`${name === undefined ? head : head.trimEnd()}>`);
    return str(`${head}${parts.join(', ')}>`);
  } finally {
    inspecting.delete(self);
  }
}

// Data -----------------------------------------------------------------------------------------------------------------

sdef('Data', 'define', [0, -1], function* (self: RClass, args, block) {
  const cls = yield* newStructClass(self, yield* membersFrom(args, 'data'), {
    keywordInit: undefined,
    kind: 'data',
  });
  if (block) yield* callProc(block, [cls], { self: cls, definee: cls });
  return cls;
});
sundef('Data', ['new', '[]']);

function* constructData(self: RClass, args: Value[], block: RProc | undefined, keywords?: RHash): Gen<RObject> {
  const { members, memberSymbols } = layoutOf(self);
  if (args.length > 0 && keywords && keywords.map.size > 0)
    throw argumentError(`wrong number of arguments (given ${args.length + 1}, expected 0)`);
  if (args.length > members.length) {
    throw argumentError(
      `wrong number of arguments (given ${args.length}, expected ${members.length === 0 ? 0 : `0..${members.length}`})`
    );
  }
  const hash: RHash = keywords ?? newHash();
  for (const [index, value] of args.entries()) yield* hashSet(hash, memberSymbols[index], value);
  const object = allocateStruct(self);
  const initialize = self.findMethod('initialize');
  if (initialize) yield* invoke(initialize, object, [], hash.map.size > 0 ? hash : undefined, block, false);
  return object;
}

def(
  'Data',
  'initialize',
  [0, 0],
  function* (self: RObject, _args, _block, keywords) {
    if (self.frozen) throw frozenError(self, yield* inspect(self));
    const { memberSymbols } = layoutOf(self.cls);
    const values = valuesOf(self);
    const given = new Set<RSymbol>();
    const unknown: string[] = [];
    for (const entry of keywords?.map.values() ?? []) {
      const name = entry.key instanceof RSymbol ? symInspect(entry.key) : `:${yield* inspect(entry.key)}`;
      const index = entry.key instanceof RSymbol ? memberSymbols.indexOf(entry.key) : -1;
      if (index === -1) unknown.push(name);
      else {
        values[index] = entry.value;
        given.add(memberSymbols[index]);
      }
    }
    const missing = memberSymbols.filter((member) => !given.has(member)).map((member) => symInspect(member));
    if (missing.length > 0)
      throw argumentError(`missing keyword${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    if (unknown.length > 0)
      throw argumentError(`unknown keyword${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    self.frozen = true;
    return NIL;
  },
  { visibility: 'private', keywords: true }
);
sdef('Data', 'members', 0, (self: RClass) => arr([...layoutOf(self).memberSymbols]));
def('Data', 'members', 0, (self: RObject) => arr([...layoutOf(self.cls).memberSymbols]));
def('Data', 'to_h', 0, (self: RObject, _args, block) => structToHash(self, block));

function* deconstructKeys(self: RObject, keys: Value): Gen<RHash> {
  const hash = newHash();
  const { members, memberSymbols, kind } = layoutOf(self.cls);
  if (keys !== NIL && !(keys instanceof RArray))
    throw typeError(`wrong argument type ${realClassOf(keys).name} (expected Array)`);
  if (keys instanceof RArray && keys.items.length > members.length) return hash;
  const names = keys === NIL ? memberSymbols : (keys as RArray).items;
  const mark = rt().held.length;
  rt().held.push(hash);
  try {
    for (const key of names) {
      let resolved = key;
      if (kind === 'data' && !(key instanceof RSymbol) && !(key instanceof RString)) {
        const converted = yield* tryImplicitConversion(key, 'to_str');
        if (converted === undefined || converted === NIL)
          throw typeError(`${yield* inspect(key)} is not a symbol nor a string`);
        if (!(converted instanceof RString))
          throw typeError(
            `can't convert ${realClassOf(key).name} to String (${realClassOf(key).name}#to_str gives ${realClassOf(converted).name})`
          );
        resolved = converted;
      }
      const named = resolved instanceof RSymbol || resolved instanceof RString;
      const index =
        resolved instanceof RSymbol
          ? memberSymbols.indexOf(resolved)
          : resolved instanceof RString
            ? memberSymbols.indexOf(RSymbol.of(resolved.s, resolved.binary, resolved.usAscii, stringBytes(resolved)))
            : yield* toIndex(resolved);
      if (named && index < 0) break;
      const normalized = index < 0 ? index + members.length : index;
      if (normalized < 0 || normalized >= members.length) break;
      yield* hashSet(hash, resolved, valuesOf(self)[normalized]);
    }
    return hash;
  } finally {
    rt().held.length = mark;
  }
}

function* structToHash(self: RObject, block: RProc | undefined): Gen<RHash> {
  const hash = newHash();
  rt().held.push(hash);
  try {
    for (const [index, name] of layoutOf(self.cls).memberSymbols.entries()) {
      const value = valuesOf(self)[index];
      if (!block) {
        yield* hashSet(hash, name, value);
        continue;
      }
      const converted = yield* callBlock(block, [name, value]);
      const pair = converted instanceof RArray ? converted : yield* tryAry(converted);
      if (!pair) throw typeError(`wrong element type ${realClassOf(converted).name} (expected array)`);
      if (pair.items.length !== 2)
        throw argumentError(`element has wrong array length (expected 2, was ${pair.items.length})`);
      yield* hashSet(hash, pair.items[0], pair.items[1]);
    }
    return hash;
  } finally {
    rt().held.pop();
  }
}
def(
  'Data',
  'with',
  [0, 0],
  function* (self: RObject, _args, _block, keywords) {
    if (!keywords) return self;
    const hash = newHash();
    for (const [index, name] of layoutOf(self.cls).memberSymbols.entries())
      yield* hashSet(hash, name, valuesOf(self)[index]);
    for (const entry of keywords.map.values()) yield* hashSet(hash, entry.key, entry.value);
    return yield* constructData(self.cls, [], undefined, hash);
  },
  { keywords: true }
);
def('Data', '==', 1, (self: RObject, [other]) => sameValues(self, other, rEquals));
def('Data', 'eql?', 1, (self: RObject, [other]) => sameValues(self, other, rEql));
def('Data', 'hash', 0, (self: RObject) => structuralHash(self));
def('Data', ['inspect', 'to_s'], 0, (self: RObject) => inspectMembers(self, 'data'));
def('Data', 'deconstruct_keys', 1, (self: RObject, [keys]) => deconstructKeys(self, keys));
def('Data', 'deconstruct', 0, (self: RObject) => arr([...valuesOf(self)]));

export { addressOf };
