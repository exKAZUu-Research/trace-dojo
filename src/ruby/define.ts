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

let singletonOf: ((cls: RClass) => RClass) | undefined;

export function setSingletonFactory(factory: (cls: RClass) => RClass): void {
  singletonOf = factory;
}

export function installNatives(runtime: Runtime): void {
  for (const spec of specs) {
    const owner = runtime.c[spec.owner];
    if (!owner) throw new Error(`Unknown library class: ${spec.owner}`);
    const target = spec.singleton ? (singletonOf as (cls: RClass) => RClass)(owner) : owner;
    for (const name of spec.names) {
      target.methods.set(name, {
        name,
        owner: target,
        visibility: spec.visibility,
        body: { kind: 'native', fn: spec.fn, min: spec.min, max: spec.max, takesKeywords: spec.takesKeywords },
      });
    }
  }
}
