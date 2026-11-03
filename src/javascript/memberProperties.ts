import type { FunctionNode } from './ast';
import type { Runtime } from './runtime';
import type { JsFunction, JsObject, Property } from './values';

/** A private method's property, or one half of a private accessor's. */
export function privateMethodProperty(kind: 'method' | 'getter' | 'setter', method: JsFunction): Property {
  if (kind === 'method') return { value: method, writable: false, enumerable: false, configurable: false };
  return {
    get: kind === 'getter' ? method : undefined,
    set: kind === 'setter' ? method : undefined,
    enumerable: false,
    configurable: false,
  };
}

export function mergePrivate(runtime: Runtime, target: JsObject, key: string, property: Property): void {
  const existing = target.privateMembers?.get(key);
  if (existing && !('value' in existing) && !('value' in property)) {
    existing.get ??= property.get;
    existing.set ??= property.set;
    return;
  }
  runtime.definePrivate(target, key, { ...property });
}

export function defineFunctionProperties(fn: JsFunction, name: string, length: number): void {
  fn.properties.set('length', { value: length, writable: false, enumerable: false, configurable: true });
  fn.properties.set('name', { value: name, writable: false, enumerable: false, configurable: true });
}

/** The number of parameters before the first default or rest one, which `length` reports. */
export function expectedArgumentCount(node: FunctionNode): number {
  const index = node.params.findIndex((param) => param.kind === 'default');
  return index === -1 ? node.params.length : index;
}
