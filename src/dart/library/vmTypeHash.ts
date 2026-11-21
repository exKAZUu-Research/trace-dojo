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

// Class IDs for public types in the Dart SDK 3.13.7 JIT platform snapshot.
const SDK_CLASS_IDS: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  [
    'dart:core',
    new Map([
      ['ArgumentError', 202],
      ['AssertionError', 200],
      ['BigInt', 194],
      ['CastIterable', 706],
      ['CastIterator', 705],
      ['CompactLinkedCustomHashMap', 410],
      ['CompactLinkedCustomHashSet', 427],
      ['CompactLinkedIdentityHashMap', 408],
      ['CompactLinkedIdentityHashSet', 425],
      ['Comparable', 195],
      ['ConcurrentModificationError', 209],
      ['Deprecated', 189],
      ['Duration', 197],
      ['EfficientLengthFollowedByIterable', 740],
      ['EfficientLengthIndexedIterable', 747],
      ['EfficientLengthIterable', 224],
      ['EfficientLengthMappedIterable', 720],
      ['EfficientLengthSkipIterable', 733],
      ['EfficientLengthTakeIterable', 728],
      ['EmptyIterable', 737],
      ['EmptyIterator', 738],
      ['Enum', 198],
      ['Error', 199],
      ['Exception', 212],
      ['ExpandIterable', 725],
      ['ExpandIterator', 726],
      ['FollowedByIterable', 739],
      ['FollowedByIterator', 741],
      ['FormatException', 214],
      ['Function', 184],
      ['IndexError', 204],
      ['IndexedIterable', 746],
      ['IndexedIterator', 748],
      ['IntegerDivisionByZeroException', 215],
      ['Invocation', 216],
      ['Iterable', 218],
      ['Iterator', 222],
      ['LateError', 714],
      ['LinkedHashMap', 392],
      ['LinkedHashSet', 394],
      ['List', 226],
      ['ListIterable', 220],
      ['ListIterator', 718],
      ['Map', 227],
      ['MapEntry', 228],
      ['MappedIterable', 719],
      ['MappedIterator', 721],
      ['MappedListIterable', 722],
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
      ['ReversedListIterable', 752],
      ['RuneIterator', 240],
      ['Runes', 239],
      ['Set', 234],
      ['SkipIterable', 732],
      ['SkipIterator', 734],
      ['SkipWhileIterable', 735],
      ['SkipWhileIterator', 736],
      ['StackOverflowError', 211],
      ['StackTrace', 236],
      ['StateError', 208],
      ['String', 188],
      ['StringBuffer', 241],
      ['StringSink', 242],
      ['SubListIterable', 717],
      ['Symbol', 243],
      ['TakeIterable', 727],
      ['TakeIterator', 729],
      ['TakeWhileIterable', 730],
      ['TakeWhileIterator', 731],
      ['Type', 183],
      ['TypeError', 201],
      ['UnimplementedError', 207],
      ['UnmodifiableSetView', 489],
      ['UnsupportedError', 206],
      ['WhereIterable', 723],
      ['WhereIterator', 724],
      ['WhereTypeIterable', 742],
      ['WhereTypeIterator', 743],
      ['bool', 63],
      ['double', 187],
      ['int', 186],
      ['num', 58],
      ['pragma', 193],
    ]),
  ],
  [
    'dart:math',
    new Map([
      ['MutableRectangle', 781],
      ['Point', 777],
      ['Random', 778],
      ['Rectangle', 780],
    ]),
  ],
  [
    'dart:collection',
    new Map([
      ['CastList', 710],
      ['CastMap', 712],
      ['CastQueue', 713],
      ['CastSet', 711],
      ['CodeUnits', 688],
      ['DoubleLinkedQueue', 481],
      ['DoubleLinkedQueueEntry', 479],
      ['HashMap', 462],
      ['HashSet', 463],
      ['ListBase', 264],
      ['ListMapView', 751],
      ['ListQueue', 483],
      ['MapBase', 430],
      ['Queue', 476],
      ['SetBase', 445],
      ['SplayTreeMap', 495],
      ['SplayTreeSet', 504],
      ['UnmodifiableListView', 460],
      ['UnmodifiableMapView', 473],
    ]),
  ],
  [
    'dart:convert',
    new Map([
      ['Base64Codec', 534],
      ['Base64Decoder', 542],
      ['Base64Encoder', 536],
      ['Codec', 535],
      ['Converter', 525],
      ['Encoding', 523],
      ['JsonCodec', 558],
      ['JsonCyclicError', 557],
      ['JsonDecoder', 563],
      ['JsonEncoder', 559],
      ['JsonUnsupportedObjectError', 556],
      ['LineSplitter', 577],
      ['Utf8Codec', 590],
      ['Utf8Decoder', 595],
      ['Utf8Encoder', 591],
    ]),
  ],
  [
    'dart:io',
    new Map([
      ['IOSink', 995],
      ['Stdout', 1080],
    ]),
  ],
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
      const classId = type.cls.vmClassId ?? SDK_CLASS_IDS.get(type.cls.library)?.get(type.cls.name);
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
