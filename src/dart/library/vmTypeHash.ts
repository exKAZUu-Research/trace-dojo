import type { DartType } from '../types';

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

export function vmTypeHash(type: DartType): number {
  switch (type.kind) {
    case 'null': {
      return hashInterface(172, true, []);
    }
    case 'dynamic': {
      return hashInterface(173, true, []);
    }
    case 'void': {
      return hashInterface(174, true, []);
    }
    case 'never': {
      return hashInterface(175, type.nullable, []);
    }
    case 'interface': {
      const classId = type.cls.library === 'dart:core' ? CORE_CLASS_IDS.get(type.cls.name) : undefined;
      if (classId !== undefined) return hashInterface(classId, type.nullable, type.args);
      let hash = type.cls.name.length;
      for (const argument of type.args) hash = Math.imul(hash, 31) + vmTypeHash(argument);
      return hash;
    }
    default: {
      return type.kind.length;
    }
  }
}

function hashInterface(classId: number, nullable: boolean, typeArguments: readonly DartType[]): number {
  let argumentsHash = 1;
  if (typeArguments.some((argument) => argument.kind !== 'dynamic')) {
    let hash = 0;
    for (const argument of typeArguments) hash = combineHashes(hash, vmTypeHash(argument));
    argumentsHash = finishHash(hash);
  }
  return finishHash(combineHashes(combineHashes(classId, nullable ? 0 : 1), argumentsHash));
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
