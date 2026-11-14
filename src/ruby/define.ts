import type { NativeFn, RClass, Visibility } from './objects';
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
  /** Builds the method from the one defined before it, for a method that handles one more kind of argument. */
  wrap?: (previous: NativeFn) => NativeFn;
}

const specs: NativeSpec[] = [];

export interface DefineOptions {
  visibility?: Visibility;
  /** Whether the method receives keyword arguments apart, instead of as a trailing Hash. */
  keywords?: boolean;
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
  specs.push({
    owner,
    names: typeof names === 'string' ? [names] : names,
    min: 0,
    max: -1,
    fn: () => undefined as never,
    singleton: true,
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

let singletonOf: ((cls: RClass) => RClass) | undefined;

export function setSingletonFactory(factory: (cls: RClass) => RClass): void {
  singletonOf = factory;
}

export function installNatives(runtime: Runtime): void {
  // Extensions apply after every definition, whatever order the modules that register them load in.
  for (const spec of [...specs.filter((each) => !each.wrap), ...specs.filter((each) => each.wrap)]) {
    const owner = runtime.c[spec.owner];
    if (!owner) throw new Error(`Unknown library class: ${spec.owner}`);
    const target = spec.singleton ? (singletonOf as (cls: RClass) => RClass)(owner) : owner;
    for (const name of spec.names) {
      if (spec.wrap) {
        const previous = target.methods.get(name);
        if (previous?.body.kind !== 'native') throw new Error(`No native ${spec.owner}#${name} to extend`);
        previous.body = { ...previous.body, fn: spec.wrap(previous.body.fn) };
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
  const kernel = runtime.c.Kernel;
  const singleton = (singletonOf as (cls: RClass) => RClass)(kernel);
  for (const [name, method] of kernel.methods) {
    if (method.visibility === 'private')
      singleton.methods.set(name, { ...method, owner: singleton, visibility: 'public' });
  }
}
