import { formatFloat } from './floatFormat';
import { addressOf } from './fmt';
import { utf8Decode } from './literals';
import { dynamicMethod } from './methods';
import { quote } from './quote';
import type { GoPanic } from './runtime';
import { ERROR_TYPE, identical, missingMethod, type Type, typeString, underlying } from './types';
import { Complex, CONSTANT_IFACES, GoFunc, GoMap, Iface, Pointer, type Value } from './values';

/** The lines Go prints for a panic that ends the program, from the first panic to the last. */
export function describePanic(panic: GoPanic): string {
  const chain: GoPanic[] = [];
  for (let current: GoPanic | undefined = panic; current; current = current.previous) chain.unshift(current);
  const lines: string[] = [];
  for (const [index, current] of chain.entries()) {
    const next = chain[index + 1];
    // A panic recovered and raised again with the same value prints once.
    if (next && current.recovered && sameValue(current.value, next.value)) {
      next.repanicked = true;
      continue;
    }
    let line = `panic: ${panicValueText(current.value)}`;
    if (current.repanicked) line += ' [recovered, repanicked]';
    else if (current.recovered) line += ' [recovered]';
    lines.push(lines.length > 0 ? `\t${line}` : line);
  }
  return lines.join('\n');
}

/**
 * Whether two panic values are the same interface words, as Go's runtime compares them: the same conversion to an
 * interface, the same pointer-shaped value (a pointer, map, or function), or data Go shares between conversions.
 */
function sameValue(a: Value, b: Value): boolean {
  if (!(a instanceof Iface) || !(b instanceof Iface)) return a === b;
  if (a === b) return true;
  if (!identical(a.type, b.type)) return false;
  if (a.value instanceof Pointer && b.value instanceof Pointer) return a.value.equals(b.value);
  if (a.value instanceof GoMap || a.value instanceof GoFunc) return a.value === b.value;
  const under = underlying(a.type);
  if (under.kind !== 'basic' || !basicEqual(a.value, b.value)) return false;
  // Go stores one-byte values in its shared table whether or not they are constants; other constants are read-only
  // data of their own, apart from the table that small values computed at run time share.
  if (ONE_BYTE_KINDS.has(under.basic)) return true;
  const constant = CONSTANT_IFACES.has(a);
  if (constant !== CONSTANT_IFACES.has(b)) return false;
  return constant || (sharedData(a.value, under.basic) && sharedData(b.value, under.basic));
}

function basicEqual(a: Value, b: Value): boolean {
  if (a instanceof Complex && b instanceof Complex) return Object.is(a.re, b.re) && Object.is(a.im, b.im);
  return Object.is(a, b);
}

/**
 * Whether Go's runtime converts a value it computed to an interface without allocating: integers and floats whose
 * bits are below 256 (`staticuint64s`), and the empty string.
 */
function sharedData(value: Value, kind: string): boolean {
  if (typeof value === 'bigint') return value >= 0n && value < 256n;
  if (typeof value === 'number') {
    const view = new DataView(new ArrayBuffer(8));
    if (kind === 'float32') view.setFloat32(4, value);
    else view.setFloat64(0, value);
    return view.getBigUint64(0) < 256n;
  }
  return value === '';
}

const ONE_BYTE_KINDS = new Set(['bool', 'int8', 'uint8']);

/** How the runtime prints a panic value: an error's message, a Stringer's text, or the value with its type. */
// code-gauge-allow functionCognitiveComplexity 20 -- Go's printpanicval, one case per kind.
export function panicValueText(value: Value): string {
  if (!(value instanceof Iface)) return 'nil';
  const { type } = value;
  const errorCall = !missingMethod(type, ERROR_TYPE.underlying as never) ? dynamicMethod(type, 'Error') : undefined;
  if (errorCall) return utf8Decode(errorCall(value.value, []) as string);
  const stringer = dynamicMethod(type, 'String');
  if (stringer && lookupStringMethod(type)) return utf8Decode(stringer(value.value, []) as string);
  const under = underlying(type);
  const named = type.kind === 'named';
  if (under.kind === 'basic') {
    let text: string;
    if (under.basic === 'string')
      text = named ? utf8Decode(quote(value.value as string)) : utf8Decode(value.value as string);
    else if (under.basic === 'bool') text = String(value.value);
    else if (under.basic === 'float32' || under.basic === 'float64')
      text = formatFloat(value.value as number, 'g', -1, under.basic === 'float32' ? 32 : 64);
    else if (value.value instanceof Complex)
      text = `(${formatFloat(value.value.re, 'g', -1, 64)}${value.value.im >= 0 ? '+' : ''}${formatFloat(value.value.im, 'g', -1, 64)}i)`;
    else text = String(value.value);
    return named ? `${typeString(type)}(${text})` : text;
  }
  const object = value.value;
  return `(${typeString(type)}) ${object && typeof object === 'object' ? addressOf(object) : '0x0'}`;
}

function lookupStringMethod(type: Type): boolean {
  return !missingMethod(type, {
    kind: 'interface',
    methods: [
      {
        name: 'String',
        type: {
          kind: 'func',
          params: [],
          results: [{ kind: 'basic', basic: 'string', name: 'string' }],
          variadic: false,
        },
      },
    ],
  });
}
