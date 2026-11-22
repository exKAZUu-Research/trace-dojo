import type { NativeFn, RClass, RMethod, Visibility } from './objects';
import { coreMethodAliases } from './rubyCoreMethods';
import type { Runtime } from './runtime';

interface NativeSpec {
  owner: string;
  names: string[];
  min: number;
  max: number;
  fn: NativeFn;
  singleton: boolean;
  visibility: Visibility;
  takesKeywords: boolean;
  undefined?: boolean;
  ifMissing?: boolean;
  /** Builds the method from the one defined before it, for a method that handles one more kind of argument. */
  wrap?: (previous: NativeFn) => NativeFn;
}

const specs: NativeSpec[] = [];
const coreMethods = new WeakMap<RClass, Map<string, RMethod>>();

export function coreMethod(owner: RClass, name: string): RMethod {
  const method = findCoreMethod(owner, name);
  if (!method) throw new Error(`Missing core method ${owner.name}#${name}`);
  return method;
}

export function findCoreMethod(owner: RClass, name: string): RMethod | undefined {
  return coreMethods.get(owner)?.get(name);
}

export function isCoreMethod(method: RMethod | undefined, owner: RClass, name: string): boolean {
  const core = findCoreMethod(owner, name);
  return method?.body.kind === 'native' && core?.body.kind === 'native' && method.body.fn === core.body.fn;
}

export interface DefineOptions {
  visibility?: Visibility;
  /** Whether the method receives keyword arguments apart, instead of as a trailing Hash. */
  keywords?: boolean;
  ifMissing?: boolean;
}

/**
 * Defines a native instance method on the library class named `owner` (`Math::DomainError` for nested ones), taking
 * `arity` arguments: a count, or `[min, max]` where `max` -1 takes any number.
 */
export function def(
  owner: string,
  names: string | string[],
  arity: number | [number, number],
  fn: NativeFn,
  options: DefineOptions = {}
): void {
  register(owner, names, arity, fn, false, options);
}

/** Defines a native method on the library class itself, such as `Integer.sqrt`. */
export function sdef(
  owner: string,
  names: string | string[],
  arity: number | [number, number],
  fn: NativeFn,
  options: DefineOptions = {}
): void {
  register(owner, names, arity, fn, true, options);
}

export function sundef(owner: string, names: string | string[]): void {
  registerUndefined(owner, names, true);
}

export function iundef(owner: string, names: string | string[]): void {
  registerUndefined(owner, names, false);
}

function registerUndefined(owner: string, names: string | string[], singleton: boolean): void {
  specs.push({
    owner,
    names: typeof names === 'string' ? [names] : names,
    min: 0,
    max: -1,
    fn: () => undefined as never,
    singleton,
    visibility: 'public',
    takesKeywords: false,
    undefined: true,
  });
}

function register(
  owner: string,
  names: string | string[],
  arity: number | [number, number],
  fn: NativeFn,
  singleton: boolean,
  options: DefineOptions
): void {
  const [min, max] = typeof arity === 'number' ? [arity, arity] : arity;
  specs.push({
    owner,
    names: typeof names === 'string' ? [names] : names,
    min,
    max,
    fn,
    singleton,
    visibility: options.visibility ?? 'public',
    takesKeywords: options.keywords ?? false,
    ifMissing: options.ifMissing,
  });
}

/**
 * Extends native instance methods defined earlier: `wrap` receives each one's function and returns the new one, which
 * keeps its arity.
 */
export function extend(owner: string, names: string[], wrap: (previous: NativeFn) => NativeFn): void {
  specs.push({
    owner,
    names,
    min: 0,
    max: 0,
    fn: () => undefined as never,
    singleton: false,
    visibility: 'public',
    takesKeywords: false,
    wrap,
  });
}

let singletonOf: ((cls: RClass, exposed?: boolean) => RClass) | undefined;

export function setSingletonFactory(factory: (cls: RClass, exposed?: boolean) => RClass): void {
  singletonOf = factory;
}

// code-gauge-allow functionCognitiveComplexity -- The ordered cases for native method registration share state; splitting them solely for the metric would hide their sequencing.
// code-gauge-allow functionNcss -- Native definitions, aliases and reflection snapshots must install in that order.
export function installNatives(runtime: Runtime): void {
  // Extensions apply after every definition, whatever order the modules that register them load in.
  for (const spec of [...specs.filter((each) => !each.wrap), ...specs.filter((each) => each.wrap)]) {
    const owner = runtime.c[spec.owner];
    if (!owner) throw new Error(`Unknown library class: ${spec.owner}`);
    const target = spec.singleton ? (singletonOf as (cls: RClass) => RClass)(owner) : owner;
    const wrapped = new Map<NativeFn, NativeFn>();
    for (const name of spec.names) {
      if (spec.ifMissing && target.ancestors().some((ancestor) => ancestor.methods.has(name))) continue;
      if (spec.wrap) {
        const previous = target.methods.get(name);
        if (previous?.body.kind !== 'native') throw new Error(`No native ${spec.owner}#${name} to extend`);
        const original = previous.body.fn;
        let fn = wrapped.get(original);
        if (!fn) {
          fn = spec.wrap(original);
          wrapped.set(original, fn);
        }
        previous.body = { ...previous.body, fn };
        continue;
      }
      target.methods.set(name, {
        name,
        owner: target,
        visibility: spec.visibility,
        body: spec.undefined
          ? { kind: 'undefined' }
          : { kind: 'native', fn: spec.fn, min: spec.min, max: spec.max, takesKeywords: spec.takesKeywords },
      });
    }
  }
  installConstructorBarriers(runtime);
  const kernel = runtime.c.Kernel;
  const singleton = (singletonOf as (cls: RClass) => RClass)(kernel);
  for (const [name, method] of kernel.methods) {
    if (method.visibility === 'private')
      singleton.methods.set(name, { ...method, owner: singleton, visibility: 'public' });
  }
  installAliasIdentities(runtime);
  for (const owner of Object.values(runtime.c))
    coreMethods.set(
      owner,
      new Map([...owner.methods].map(([name, method]) => [name, { ...method, body: { ...method.body } }]))
    );
}

function installAliasIdentities(runtime: Runtime): void {
  for (const [owner, names] of coreMethodAliases) {
    const functions = names.flatMap((name) => {
      const body = runtime.c[owner].methods.get(name)?.body;
      return body?.kind === 'native' ? [body.fn] : [];
    });
    const identity = functions.find((fn) => fn.nativeIdentity)?.nativeIdentity ?? {};
    for (const fn of functions) fn.nativeIdentity = identity;
  }
}

function installConstructorBarriers(runtime: Runtime): void {
  for (const owner of Object.values(runtime.c)) {
    if (owner.instanceKind !== 'none') continue;
    const target = (singletonOf as (cls: RClass, exposed?: boolean) => RClass)(owner, false);
    if (!target.methods.has('new'))
      target.methods.set('new', { name: 'new', owner: target, visibility: 'public', body: { kind: 'undefined' } });
  }
}
