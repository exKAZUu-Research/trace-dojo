import type { Runtime } from '../runtime';
import {
  boundOf,
  type DartType,
  DYNAMIC,
  type FunctionType,
  type RecordType,
  type TypeParam,
  type TypeParamType,
} from '../types';

interface FunctionParameterHash {
  base: number;
  index: number;
  parameterCounts: number;
  typeParameterCounts: number;
}
type FunctionParameters = ReadonlyMap<TypeParam, FunctionParameterHash>;
const EMPTY_PARAMETERS: FunctionParameters = new Map();

// Class IDs in the Dart SDK 3.13.7 VM's core snapshot.
const CORE_CLASS_IDS: ReadonlyMap<string, number> = new Map([
  ['ArgumentError', 202],
  ['AssertionError', 200],
  ['BigInt', 194],
  ['Comparable', 195],
  ['ConcurrentModificationError', 209],
  ['Deprecated', 189],
  ['Duration', 197],
  ['Enum', 198],
  ['Error', 199],
  ['Exception', 212],
  ['FormatException', 214],
  ['Function', 184],
  ['IndexError', 204],
  ['IntegerDivisionByZeroException', 215],
  ['Invocation', 216],
  ['Iterable', 218],
  ['Iterator', 222],
  ['List', 226],
  ['Map', 227],
  ['MapEntry', 228],
  ['Match', 230],
  ['NoSuchMethodError', 205],
  ['Null', 172],
  ['Object', 45],
  ['OutOfMemoryError', 210],
  ['Pattern', 229],
  ['RangeError', 203],
  ['Record', 185],
  ['RegExp', 231],
  ['RegExpMatch', 232],
  ['RuneIterator', 240],
  ['Runes', 239],
  ['Set', 234],
  ['StackOverflowError', 211],
  ['StackTrace', 236],
  ['StateError', 208],
  ['String', 188],
  ['StringBuffer', 241],
  ['StringSink', 242],
  ['Symbol', 243],
  ['Type', 183],
  ['TypeError', 201],
  ['UnimplementedError', 207],
  ['UnsupportedError', 206],
  ['bool', 63],
  ['double', 187],
  ['int', 186],
  ['num', 58],
  ['pragma', 193],
]);

export function vmTypeHash(runtime: Runtime, type: DartType, parameters = EMPTY_PARAMETERS): number {
  runtime.spend();
  const hash: (nested: DartType) => number = (nested) => vmTypeHash(runtime, nested, parameters);
  switch (type.kind) {
    case 'null': {
      return hashInterface(172, true);
    }
    case 'dynamic': {
      return hashInterface(173, true);
    }
    case 'void': {
      return hashInterface(174, true);
    }
    case 'never': {
      return hashInterface(175, type.nullable);
    }
    case 'interface': {
      const classId = type.cls.library === 'dart:core' ? CORE_CLASS_IDS.get(type.cls.name) : undefined;
      if (classId !== undefined) return hashInterface(classId, type.nullable, hashArguments(type.args, hash));
      let result = type.cls.name.length;
      for (const argument of type.args) result = Math.imul(result, 31) + hash(argument);
      return result;
    }
    case 'record': {
      return hashRecord(runtime, type, hash);
    }
    case 'function': {
      return hashFunction(runtime, type, parameters);
    }
    case 'typeParam': {
      return hashParameter(type, parameters);
    }
  }
}

function hashRecord(runtime: Runtime, type: RecordType, hash: (type: DartType) => number): number {
  const names = type.named.length > 0 ? JSON.stringify(type.named.map(({ name }) => name)) : undefined;
  const shape = runtime.recordShapes.shape(type.positional.length + type.named.length, names);
  let result = combineHashes(combineHashes(0, nullability(type.nullable)), Number(BigInt.asUintN(32, shape)));
  for (const field of type.positional) result = combineHashes(result, hash(field));
  for (const field of type.named) result = combineHashes(result, hash(field.type));
  return finishHash(result);
}

function hashParameter(type: TypeParamType, parameters: FunctionParameters): number {
  const parameter = parameters.get(type.param);
  if (!parameter) return type.kind.length;
  let result = combineHashes(parameter.base, parameter.index);
  result = combineHashes(result, nullability(type.nullable));
  result = combineHashes(result, parameter.parameterCounts);
  return finishHash(combineHashes(result, parameter.typeParameterCounts));
}

function hashFunction(runtime: Runtime, type: FunctionType, outer: FunctionParameters): number {
  const optionalCount = type.positional.length - type.requiredCount + type.named.length;
  // The VM includes the implicit closure as one required parameter in the packed counts and in the signature.
  const parameterCounts = 1 | (type.named.length > 0 ? 2 : 0) | ((type.requiredCount + 1) << 2) | (optionalCount << 16);
  const typeParameterCounts = outer.size | (type.typeParams.length << 8);
  const parameters = new Map(outer);
  for (const [index, parameter] of type.typeParams.entries()) {
    parameters.set(parameter, { base: outer.size, index: outer.size + index, parameterCounts, typeParameterCounts });
  }
  const hash = (nested: DartType): number => vmTypeHash(runtime, nested, parameters);
  let result = combineHashes(combineHashes(parameterCounts, typeParameterCounts), nullability(type.nullable));
  if (type.typeParams.length > 0) result = combineHashes(result, hashArguments(type.typeParams.map(boundOf), hash));
  result = combineHashes(result, hash(type.returnType));
  result = combineHashes(result, hash(DYNAMIC));
  for (const parameter of type.positional) result = combineHashes(result, hash(parameter));
  for (const parameter of type.named) result = combineHashes(result, hash(parameter.type));
  for (const { name } of type.named) {
    result = combineHashes(result, Number(runtime.getProperty(name, 'hashCode', undefined)));
  }
  return finishHash(result);
}

function hashArguments(typeArguments: readonly DartType[], hash: (type: DartType) => number): number {
  if (typeArguments.every((argument) => argument.kind === 'dynamic')) return 1;
  let result = 0;
  for (const argument of typeArguments) result = combineHashes(result, hash(argument));
  return finishHash(result);
}

function hashInterface(classId: number, nullable: boolean, argumentsHash = 1): number {
  return finishHash(combineHashes(combineHashes(classId, nullability(nullable)), argumentsHash));
}

function nullability(nullable: boolean): number {
  return nullable ? 0 : 1;
}

function combineHashes(previous: number, other: number): number {
  const sum = previous + other;
  const mixed = sum + (sum << 10);
  return (mixed ^ (mixed >>> 6)) >>> 0;
}

function finishHash(hash: number): number {
  const mixed = hash + (hash << 3);
  const shifted = mixed ^ (mixed >>> 11);
  return (shifted + (shifted << 15)) & 0x3f_ff_ff_ff || 1;
}
