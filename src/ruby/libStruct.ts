import { addressOf, inspect, rEql, rEquals, toIndex } from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, indexError, nameError, typeError } from './errors';
import { hashKeyOf, hashSet } from './hashes';
import { addMethod, callBlock, callMethod, callProc, type Gen, invoke, methodMissing } from './interp';
import { makeEnumerator } from './libEnumerator';
import { nameOf } from './libMeta';
import { NIL, RClass, type RHash, RObject, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { arr, newHash, realClassOf, str, sym, truthy } from './values';

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
    throw indexError(
      `offset ${raw} too ${raw < 0 ? 'small' : 'large'} for struct(size:${members.length})`
    );
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
        fn: function* (self: RObject, [value]) {
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
  yield* [];
  return cls;
}

// Struct ---------------------------------------------------------------------------------------------------------------

sdef('Struct', 'new', [0, -1], function* (self: RClass, args, block, keywords) {
  if (self !== rt().c.Struct) {
    const object = new RObject(self);
    object.data = new StructValues(layoutOf(self).members.map(() => NIL));
    const initialize = self.findMethod('initialize');
    if (initialize) {
      yield* invoke(initialize, object, args, keywords, block, false);
    }
    return object;
  }
  let keywordInit: boolean | undefined;
  if (keywords) {
    for (const entry of keywords.map.values()) {
      if (entry.key instanceof RSymbol && entry.key.name === 'keyword_init') keywordInit = entry.value === NIL ? undefined : truthy(entry.value);
      else throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
    }
  }
  let names = args;
  if (args[0] instanceof RString) names = args.slice(1);
  if (names.length === 0 && !keywordInit) throw argumentError('wrong number of arguments (given 0, expected 1+)');
  const cls = yield* newStructClass(rt().c.Struct, yield* membersFrom(names), { keywordInit, kind: 'struct' });
  if (block) yield* callProc(block, [cls], { self: cls, definee: cls });
  return cls;
}, { keywords: true });


def('Struct', 'initialize', [0, -1], function* (self: RObject, args, _block, keywords) {
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
}, { visibility: 'private', keywords: true });
sdef('Struct', 'members', 0, (self: RClass) => arr(layoutOf(self).members.map((name) => sym(name))));
sdef('Struct', 'keyword_init?', 0, (self: RClass) => layoutOf(self).keywordInit ?? NIL);
def('Struct', 'members', 0, (self: RObject) => arr(layoutOf(self.cls).members.map((name) => sym(name))));
def('Struct', ['to_a', 'deconstruct', 'values'], 0, (self: RObject) => arr([...valuesOf(self)]));
def('Struct', 'to_h', 0, function* (self: RObject, _args, block) {
  const hash = newHash();
  const { members } = layoutOf(self.cls);
  for (const [index, name] of members.entries()) {
    if (block) {
      const pair = yield* callBlock(block, [sym(name), valuesOf(self)[index]]);
      const items = (pair as { items?: Value[] }).items ?? [];
      yield* hashSet(hash, items[0] ?? NIL, items[1] ?? NIL);
    } else {
      yield* hashSet(hash, sym(name), valuesOf(self)[index]);
    }
  }
  return hash;
});
def('Struct', 'deconstruct_keys', 1, function* (self: RObject) {
  const hash = newHash();
  for (const [index, name] of layoutOf(self.cls).members.entries()) yield* hashSet(hash, sym(name), valuesOf(self)[index]);
  return hash;
});
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
  for (const value of [...valuesOf(self)]) yield* callBlock(block, [value], false);
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
def('Struct', 'hash', 0, function* (self: RObject) {
  let key = className(self.cls);
  for (const value of valuesOf(self)) key += yield* hashKeyOf(value);
  return BigInt(key.length);
});
def('Struct', ['inspect', 'to_s'], 0, (self: RObject) => inspectMembers(self, 'struct'));

function* sameValues(self: RObject, other: Value, equal: (a: Value, b: Value) => Gen<boolean>): Gen<boolean> {
  if (self === other) return true;
  if (!(other instanceof RObject) || realClassOf(other) !== realClassOf(self)) return false;
  const left = valuesOf(self);
  const right = valuesOf(other);
  for (let index = 0; index < left.length; index++) if (!(yield* equal(left[index], right[index]))) return false;
  return true;
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
sdef('Data', ['new', '[]'], [0, -1], function* (self: RClass, args, block, keywords) {
  if (self === rt().c.Data) methodMissing(self, 'new', {});
  const { members } = layoutOf(self);
  if (args.length > members.length) {
    throw argumentError(`wrong number of arguments (given ${args.length}, expected ${members.length === 0 ? 0 : `0..${members.length}`})`);
  }
  const hash: RHash = keywords ?? newHash();
  for (const [index, value] of args.entries()) yield* hashSet(hash, sym(members[index]), value);
  const object = new RObject(self);
  object.data = new StructValues(members.map(() => NIL));
  const initialize = self.findMethod('initialize');
  if (initialize) yield* invoke(initialize, object, [], hash.map.size > 0 ? hash : undefined, block, false);
  object.frozen = true;
  return object;
}, { keywords: true });

def('Data', 'initialize', [0, 0], function* (self: RObject, _args, _block, keywords) {
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
  if (missing.length > 0) throw argumentError(`missing keyword${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  if (unknown.length > 0) throw argumentError(`unknown keyword${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return NIL;
}, { visibility: 'private', keywords: true });
sdef('Data', 'members', 0, (self: RClass) => arr(layoutOf(self).members.map((name) => sym(name))));
def('Data', 'members', 0, (self: RObject) => arr(layoutOf(self.cls).members.map((name) => sym(name))));
def('Data', 'to_h', 0, function* (self: RObject) {
  const hash = newHash();
  for (const [index, name] of layoutOf(self.cls).members.entries()) yield* hashSet(hash, sym(name), valuesOf(self)[index]);
  return hash;
});
def('Data', 'with', [0, 0], function* (self: RObject, _args, _block, keywords) {
  if (!keywords) return self;
  const hash = newHash();
  for (const [index, name] of layoutOf(self.cls).members.entries()) yield* hashSet(hash, sym(name), valuesOf(self)[index]);
  for (const entry of keywords.map.values()) yield* hashSet(hash, entry.key, entry.value);
  return yield* callMethod(self.cls, 'new', [], hash);
}, { keywords: true });
def('Data', '==', 1, (self: RObject, [other]) => sameValues(self, other, rEquals));
def('Data', 'eql?', 1, (self: RObject, [other]) => sameValues(self, other, rEql));
def('Data', 'hash', 0, function* (self: RObject) {
  let key = className(self.cls);
  for (const value of valuesOf(self)) key += yield* hashKeyOf(value);
  return BigInt(key.length);
});
def('Data', ['inspect', 'to_s'], 0, (self: RObject) => inspectMembers(self, 'data'));
def('Data', 'deconstruct_keys', 1, function* (self: RObject) {
  const hash = newHash();
  for (const [index, name] of layoutOf(self.cls).members.entries()) yield* hashSet(hash, sym(name), valuesOf(self)[index]);
  return hash;
});
def('Data', 'deconstruct', 0, (self: RObject) => arr([...valuesOf(self)]));

export { addressOf };
