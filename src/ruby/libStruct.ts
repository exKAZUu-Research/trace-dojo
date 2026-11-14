import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { addressOf, inspect, rEql, rEquals, toIndex, toInt } from './conversions';
import { def, sdef, sundef } from './define';
import { argumentError, frozenError, indexError, nameError, typeError } from './errors';
import { digest, hashKeyOf, hashSet } from './hashes';
import { addMethod, assertMutableClass, callBlock, callMethod, callProc, type Gen, invoke } from './interp';
import { tryAry } from './libArray';
import { makeEnumerator } from './libEnumerator';
import { nameOf } from './libMeta';
import { NIL, RArray, RClass, type RHash, RObject, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { arr, newHash, realClassOf, singletonClassOf, str, sym, truthy } from './values';

/** The members of a Struct or Data class, and whether its `new` takes keywords only. */
interface Layout {
  members: string[];
  keywordInit: boolean | undefined;
  kind: 'struct' | 'data';
}

const layouts = new WeakMap<RClass, Layout>();

function layoutOf(cls: RClass): Layout {
  for (let current: RClass | undefined = cls; current; current = current.superclass) {
    const layout = layouts.get(current);
    if (layout) return layout;
  }
  throw typeError('not a struct');
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
  const { members } = layoutOf(self.cls);
  if (key instanceof RSymbol || key instanceof RString) {
    const name = key instanceof RSymbol ? key.name : key.s;
    const index = members.indexOf(name);
    if (index === -1) {
      throw nameError(`no member '${name}' in struct`, self, name);
    }
    return index;
  }
  let index = yield* toIndex(key);
  if (index < 0) index += members.length;
  if (index < 0 || index >= members.length) {
    const raw = yield* toIndex(key);
    throw indexError(`offset ${raw} too ${raw < 0 ? 'small' : 'large'} for struct(size:${members.length})`);
  }
  return index;
}

function* membersFrom(args: Value[]): Gen<string[]> {
  const members: string[] = [];
  for (const arg of args) {
    const name = yield* nameOf(arg);
    if (members.includes(name)) throw argumentError(`duplicate member: ${name}`);
    members.push(name);
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

function* newStructClass(superclass: RClass, members: string[], layout: Omit<Layout, 'members'>): Gen<RClass> {
  const cls = new RClass(rt().c.Class, undefined, superclass, false);
  cls.isUserDefined = true;
  layouts.set(cls, { ...layout, members });
  defineAccessors(cls, members, layout.kind === 'struct');
  const singleton = singletonClassOf(cls);
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
            : name === 'new'
              ? constructStruct(self as RClass, args, block, keywords)
              : callMethod(self, 'new', args, keywords, block),
        min: 0,
        max: -1,
        takesKeywords: true,
      },
    });
  }
  yield* [];
  return cls;
}

function* constructStruct(self: RClass, args: Value[], block: RProc | undefined, keywords?: RHash): Gen<RObject> {
  const object = new RObject(self);
  object.data = new StructValues(layoutOf(self).members.map(() => NIL));
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
    if (first !== undefined && first !== NIL && !(first instanceof RString) && !(first instanceof RSymbol))
      throw typeError(`no implicit conversion of ${realClassOf(first).name} into String`);
    let keywordInit: boolean | undefined;
    if (keywords) {
      for (const entry of keywords.map.values()) {
        if (entry.key instanceof RSymbol && entry.key.name === 'keyword_init')
          keywordInit = entry.value === NIL ? undefined : truthy(entry.value);
        else throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
      }
    }
    const names = first instanceof RString || first === NIL ? args.slice(1) : args;
    const name = first instanceof RString ? first.s : undefined;
    if (name !== undefined) {
      if (!/^[\p{Lu}\p{Lt}][\p{L}\p{M}\p{N}_]*$/u.test(name))
        throw nameError(`identifier ${name} needs to be constant`);
      assertMutableClass(self);
    }
    if (names.length === 0 && !keywordInit && first !== NIL && name === undefined)
      throw argumentError('wrong number of arguments (given 0, expected 1+)');
    const cls = yield* newStructClass(self, yield* membersFrom(names), { keywordInit, kind: 'struct' });
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
    const { members, keywordInit } = layoutOf(self.cls);
    const values = valuesOf(self);
    if (keywordInit || (keywordInit === undefined && args.length === 0 && keywords)) {
      if (args.length > 0) throw argumentError(`wrong number of arguments (given ${args.length}, expected 0)`);
      const unknown: string[] = [];
      for (const entry of keywords?.map.values() ?? []) {
        const name = entry.key instanceof RSymbol ? entry.key.name : yield* inspect(entry.key);
        const index = members.indexOf(name);
        if (index === -1) unknown.push(name);
        else values[index] = entry.value;
      }
      if (unknown.length > 0) throw argumentError(`unknown keywords: ${unknown.join(', ')}`);
      return NIL;
    }
    const all = keywords ? [...args, keywords] : args;
    if (all.length > members.length) throw argumentError('struct size differs');
    for (const [index, value] of all.entries()) values[index] = value;
    return NIL;
  },
  { visibility: 'private', keywords: true }
);
sdef('Struct', 'members', 0, (self: RClass) => arr(layoutOf(self).members.map((name) => sym(name))));
sdef('Struct', 'keyword_init?', 0, (self: RClass) => layoutOf(self).keywordInit ?? NIL);
def('Struct', 'members', 0, (self: RObject) => arr(layoutOf(self.cls).members.map((name) => sym(name))));
def('Struct', ['to_a', 'deconstruct', 'values'], 0, (self: RObject) => arr([...valuesOf(self)]));
def('Struct', 'values_at', [0, -1], function* (self: RObject, args) {
  const values = valuesOf(self);
  for (const argument of args) {
    if (argument instanceof RRange) continue;
    const index = yield* toInt(argument);
    if (index < -BigInt(values.length)) throw indexError(`offset ${index} too small for struct(size:${values.length})`);
    if (index >= BigInt(values.length)) throw indexError(`offset ${index} too large for struct(size:${values.length})`);
  }
  return yield* callMethod(arr([...values]), 'values_at', args);
});
def('Struct', 'to_h', 0, (self: RObject, _args, block) => structToHash(self, block));
def('Struct', 'deconstruct_keys', 1, (self: RObject, [keys]) => deconstructKeys(self, keys));
def('Struct', '[]', 1, function* (self: RObject, [key]) {
  return valuesOf(self)[yield* memberIndex(self, key)];
});
def('Struct', '[]=', 2, function* (self: RObject, [key, value]) {
  if (self.frozen) throw frozenError(self, yield* inspect(self));
  valuesOf(self)[yield* memberIndex(self, key)] = value;
  return value;
});
def('Struct', ['each'], 0, function* (self: RObject, _args, block) {
  if (!block) return makeEnumerator(self, 'each', []);
  for (let index = 0; index < valuesOf(self).length; index++) yield* callBlock(block, [valuesOf(self)[index]], false);
  return self;
});
def('Struct', 'each_pair', 0, function* (self: RObject, _args, block) {
  if (!block) return makeEnumerator(self, 'each_pair', []);
  for (const [index, name] of layoutOf(self.cls).members.entries()) {
    yield* callBlock(block, [arr([sym(name), valuesOf(self)[index]])], false);
  }
  return self;
});
def('Struct', ['size', 'length'], 0, (self: RObject) => BigInt(valuesOf(self).length));
def('Struct', 'dig', [1, -1], function* (self: RObject, args) {
  const value = valuesOf(self)[yield* memberIndex(self, args[0])];
  if (args.length === 1 || value === NIL) return value;
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
    const parts = [className(self.cls)];
    for (const value of valuesOf(self)) parts.push(yield* hashKeyOf(value));
    return BigInt(`0x${digest(JSON.stringify(parts))}`);
  } finally {
    runtime.structHashDepth--;
    runtime.structHashing.delete(self);
  }
}

function className(cls: RClass): string {
  return realClassOf(new RObject(cls)).name ?? '';
}

const inspecting = new Set<RObject>();

function* inspectMembers(self: RObject, kind: 'struct' | 'data'): Gen {
  const name = realClassOf(self).name;
  const head = name === undefined ? `#<${kind} ` : `#<${kind} ${name} `;
  if (inspecting.has(self)) return str(`${head.trimEnd()}:...>`);
  inspecting.add(self);
  try {
    const parts: string[] = [];
    for (const [index, member] of layoutOf(self.cls).members.entries()) {
      parts.push(`${member}=${yield* inspect(valuesOf(self)[index])}`);
    }
    if (parts.length === 0) return str(`${head.trimEnd()}>`);
    return str(`${head}${parts.join(', ')}>`);
  } finally {
    inspecting.delete(self);
  }
}

// Data -----------------------------------------------------------------------------------------------------------------

sdef('Data', 'define', [0, -1], function* (_self, args, block) {
  const cls = yield* newStructClass(rt().c.Data, yield* membersFrom(args), { keywordInit: undefined, kind: 'data' });
  if (block) yield* callProc(block, [cls], { self: cls, definee: cls });
  return cls;
});
sundef('Data', ['new', '[]']);

function* constructData(self: RClass, args: Value[], block: RProc | undefined, keywords?: RHash): Gen<RObject> {
  const { members } = layoutOf(self);
  if (args.length > 0 && keywords && keywords.map.size > 0)
    throw argumentError(`wrong number of arguments (given ${args.length + 1}, expected 0)`);
  if (args.length > members.length) {
    throw argumentError(
      `wrong number of arguments (given ${args.length}, expected ${members.length === 0 ? 0 : `0..${members.length}`})`
    );
  }
  const hash: RHash = keywords ?? newHash();
  for (const [index, value] of args.entries()) yield* hashSet(hash, sym(members[index]), value);
  const object = new RObject(self);
  object.data = new StructValues(members.map(() => NIL));
  const initialize = self.findMethod('initialize');
  if (initialize) yield* invoke(initialize, object, [], hash.map.size > 0 ? hash : undefined, block, false);
  object.frozen = true;
  return object;
}

def(
  'Data',
  'initialize',
  [0, 0],
  function* (self: RObject, _args, _block, keywords) {
    const { members } = layoutOf(self.cls);
    const values = valuesOf(self);
    const given = new Set<string>();
    const unknown: string[] = [];
    for (const entry of keywords?.map.values() ?? []) {
      const name = entry.key instanceof RSymbol ? entry.key.name : yield* inspect(entry.key);
      const index = members.indexOf(name);
      if (index === -1) unknown.push(`:${name}`);
      else {
        values[index] = entry.value;
        given.add(name);
      }
    }
    const missing = members.filter((name) => !given.has(name)).map((name) => `:${name}`);
    if (missing.length > 0)
      throw argumentError(`missing keyword${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    if (unknown.length > 0)
      throw argumentError(`unknown keyword${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    return NIL;
  },
  { visibility: 'private', keywords: true }
);
sdef('Data', 'members', 0, (self: RClass) => arr(layoutOf(self).members.map((name) => sym(name))));
def('Data', 'members', 0, (self: RObject) => arr(layoutOf(self.cls).members.map((name) => sym(name))));
def('Data', 'to_h', 0, (self: RObject, _args, block) => structToHash(self, block));

function* deconstructKeys(self: RObject, keys: Value): Gen<RHash> {
  const hash = newHash();
  const members = layoutOf(self.cls).members;
  if (keys !== NIL && !(keys instanceof RArray))
    throw typeError(`wrong argument type ${realClassOf(keys).name} (expected Array)`);
  if (keys instanceof RArray && keys.items.length > members.length) return hash;
  const names = keys === NIL ? members.map((name) => sym(name)) : (keys as RArray).items;
  for (const key of names) {
    if (!(key instanceof RSymbol)) break;
    const index = members.indexOf(key.name);
    if (index === -1) break;
    yield* hashSet(hash, key, valuesOf(self)[index]);
  }
  return hash;
}

function* structToHash(self: RObject, block: RProc | undefined): Gen<RHash> {
  const hash = newHash();
  for (const [index, name] of layoutOf(self.cls).members.entries()) {
    const value = valuesOf(self)[index];
    if (!block) {
      yield* hashSet(hash, sym(name), value);
      continue;
    }
    const converted = yield* callBlock(block, [sym(name), value]);
    const pair = converted instanceof RArray ? converted : yield* tryAry(converted);
    if (!pair) throw typeError(`wrong element type ${realClassOf(converted).name} (expected array)`);
    if (pair.items.length !== 2)
      throw argumentError(`element has wrong array length (expected 2, was ${pair.items.length})`);
    yield* hashSet(hash, pair.items[0], pair.items[1]);
  }
  return hash;
}
def(
  'Data',
  'with',
  [0, 0],
  function* (self: RObject, _args, _block, keywords) {
    if (!keywords) return self;
    const hash = newHash();
    for (const [index, name] of layoutOf(self.cls).members.entries())
      yield* hashSet(hash, sym(name), valuesOf(self)[index]);
    for (const entry of keywords.map.values()) yield* hashSet(hash, entry.key, entry.value);
    return yield* callMethod(self.cls, 'new', [], hash);
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
