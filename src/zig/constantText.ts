import { type AnyFloat, shortestDecimal } from './floats';
import type { Type } from './types';
import { decodeIdentifierBytes } from './utf8';
import {
  EnumLiteral,
  ErrorValue,
  FnValue,
  isUndefinedMemory,
  NULL,
  Pointer,
  type Slice,
  Some,
  type Value,
  ZArray,
  type ZStruct,
  type ZUnion,
} from './values';

// code-gauge-allow functionNcss 37 -- Dispatches typed constants while aggregate and scalar renderers share the same recursion.
export function constantText(value: Value, type: Type, nameOf: (type: Type) => string): string {
  if (isUndefinedMemory(value)) return 'undefined';
  if (value === NULL) return 'null';
  if (value instanceof ErrorValue) return `error.${value.name}`;
  if (value instanceof EnumLiteral) return `.${value.name}`;
  switch (type.kind) {
    case 'float':
    case 'comptime_float': {
      return floatText(value as AnyFloat, type.kind === 'float' ? type.bits : 128);
    }
    case 'type': {
      return nameOf(value as Type);
    }
    case 'void': {
      return '{}';
    }
    case 'undefined': {
      return 'undefined';
    }
    case 'optional': {
      return constantText(value instanceof Some ? value.value : value, type.child, nameOf);
    }
    case 'error_union': {
      return constantText(value, type.payload, nameOf);
    }
    case 'enum': {
      return `.${type.fields?.find((field) => field.value === value)?.name ?? String(value as bigint)}`;
    }
    case 'array': {
      return arrayText(value as ZArray, type.child, nameOf);
    }
    case 'pointer': {
      return pointerText(value, type, nameOf);
    }
    case 'struct': {
      return structText(value as ZStruct, type, nameOf);
    }
    case 'union': {
      return unionText(value as ZUnion, type, nameOf);
    }
    case 'fn': {
      return functionText(value);
    }
    default: {
      return typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'number'
        ? String(value)
        : 'undefined';
    }
  }
}

function structText(value: ZStruct, type: Extract<Type, { kind: 'struct' }>, nameOf: (type: Type) => string): string {
  return aggregateText(
    (type.fields ?? []).map((field, index) => {
      const contents = field.comptimeValue ? field.comptimeValue.value : value.slots[index];
      const prefix = type.isTuple ? '' : `.${field.name} = `;
      return prefix + constantText(contents, field.type, nameOf);
    })
  );
}

function unionText(value: ZUnion, type: Extract<Type, { kind: 'union' }>, nameOf: (type: Type) => string): string {
  const field = type.fields?.[value.tag];
  return field ? aggregateText([`.${field.name} = ${constantText(value.slots[0], field.type, nameOf)}`]) : 'undefined';
}

function functionText(value: Value): string {
  const name =
    value instanceof FnValue
      ? value.fn.name
      : typeof value === 'object' && value && 'functionName' in value
        ? value.functionName
        : '';
  return `(function '${name}')`;
}

function floatText(value: AnyFloat, bits: 16 | 32 | 64 | 80 | 128): string {
  const decimal = shortestDecimal(value, bits);
  const sign = decimal.sign ? '-' : '';
  if (decimal.special) return sign + decimal.special;
  const digits = decimal.mantissa.toString();
  const point = digits.length + decimal.exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function arrayText(value: ZArray, child: Type, nameOf: (type: Type) => string): string {
  return child.kind === 'int' && !child.signed && child.bits === 8
    ? `${quotedBytes(value.values().map(Number))}.*`
    : aggregateText(value.values().map((item) => constantText(item, child, nameOf)));
}

function pointerText(value: Value, type: Extract<Type, { kind: 'pointer' }>, nameOf: (type: Type) => string): string {
  if (type.size === 'slice') {
    const slice = value as Slice;
    const array = new ZArray(slice.target.slots, slice.start, slice.lengthValue);
    const content = arrayText(array, type.child, nameOf);
    const prefix =
      type.child.kind === 'int' && !type.child.signed && type.child.bits === 8 ? content.slice(0, -2) : `&${content}`;
    return `${prefix}[0..${slice.lengthValue}]`;
  }
  if (
    value instanceof Pointer &&
    type.child.kind === 'array' &&
    type.child.child.kind === 'int' &&
    type.child.child.bits === 8 &&
    !type.child.child.signed
  )
    return quotedBytes((value.load() as ZArray).values().map(Number));
  return '0';
}

function aggregateText(fields: string[]): string {
  return fields.length === 0 ? '.{}' : `.{ ${fields.join(', ')} }`;
}

function quotedBytes(bytes: readonly number[]): string {
  let result = '"';
  for (const character of decodeIdentifierBytes(bytes)) {
    const point = character.codePointAt(0) as number;
    if (character === '"' || character === '\\') result += `\\${character}`;
    else if (point === 10) result += String.raw`\n`;
    else if (point === 13) result += String.raw`\r`;
    else if (point === 9) result += String.raw`\t`;
    else if (point < 32 || point === 127 || (point >= 0xdc_80 && point <= 0xdc_ff))
      result += `\\x${(point >= 0xdc_80 ? point - 0xdc_00 : point).toString(16).padStart(2, '0')}`;
    else result += character;
  }
  return result + '"';
}
