import { type Type, typeString, underlying } from './types';
import type { Complex, GoArray, GoStruct, Iface, Value } from './values';

/** Orders map keys as fmt prints them (internal/fmtsort): numbers and strings by value, NaN first, false first. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of key.
export function compareMapKeys(a: Value, b: Value, type: Type): number {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      return compareBasic(a, b, under.basic);
    }
    case 'struct': {
      for (const [index, field] of under.fields.entries()) {
        const order = compareMapKeys((a as GoStruct).fields[index], (b as GoStruct).fields[index], field.type);
        if (order !== 0) return order;
      }
      return 0;
    }
    case 'array': {
      for (const [index, item] of (a as GoArray).elements.entries()) {
        const order = compareMapKeys(item, (b as GoArray).elements[index], under.element);
        if (order !== 0) return order;
      }
      return 0;
    }
    case 'interface': {
      if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
      const x = a as Iface;
      const y = b as Iface;
      // Go orders different dynamic types by the addresses of their type descriptors, which vary; kinds come here in
      // the order observed on Go 1.27.
      const rank = kindRank(x.type) - kindRank(y.type);
      if (rank !== 0) return rank;
      const names = typeString(x.type).localeCompare(typeString(y.type));
      if (names !== 0) return names;
      return compareMapKeys(x.value, y.value, x.type);
    }
    default: {
      return 0;
    }
  }
}

function compareBasic(a: Value, b: Value, kind: string): number {
  if (kind === 'bool') return a === b ? 0 : a ? 1 : -1;
  if (kind === 'complex64' || kind === 'complex128') {
    const x = a as Complex;
    const y = b as Complex;
    return compareNumbers(x.re, y.re) || compareNumbers(x.im, y.im);
  }
  if (typeof a === 'number') return compareNumbers(a, b as number);
  if (a === b) return 0;
  return (a as string | bigint) < (b as string | bigint) ? -1 : 1;
}

function compareNumbers(a: number, b: number): number {
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
  if (Number.isNaN(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function kindRank(type: Type): number {
  const under = underlying(type);
  if (under.kind !== 'basic') return 10;
  if (under.basic === 'string') return 0;
  if (under.basic.startsWith('int') || under.basic.startsWith('uint')) return 1;
  if (under.basic.startsWith('float')) return 2;
  if (under.basic === 'bool') return 3;
  return 4;
}
