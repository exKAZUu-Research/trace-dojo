import { byteAt } from '../bytes';
import { CppException, CppRuntimeError } from '../errors';
import type { Frame, Runtime } from '../runtime';
import {
  type ClassInfo,
  classType,
  CONST_CHAR,
  type FunctionInfo,
  type NativeFunction,
  type ParamInfo,
  referenceTo,
  type Type,
  withConst,
} from '../types';
import { ArrayStore, CObject, type Ptr, type Value } from '../values';

export interface NativeOptions {
  isConst?: boolean;
  isStatic?: boolean;
  isVirtual?: boolean;
  isExplicit?: boolean;
  isVariadic?: boolean;
  /** How many trailing parameters a call may leave out. */
  optional?: number;
  owner?: ClassInfo;
  displayName?: string;
  uses?: FunctionInfo['nativeUses'];
  libraryConstant?: FunctionInfo['libraryConstant'];
  constantAccess?: FunctionInfo['constantAccess'];
}

/** A library function with fixed parameter types. */
export function native(
  name: string,
  params: Type[],
  ret: Type,
  run: NativeFunction,
  options: NativeOptions = {}
): FunctionInfo {
  const optional = options.optional ?? 0;
  const paramInfos: ParamInfo[] = params.map((type, index) => ({
    name: `p${index}`,
    type,
    row: -1,
    isOptional: index >= params.length - optional,
  }));
  return {
    name,
    displayName: options.displayName ?? (options.owner ? `${options.owner.name}::${name}` : `std::${name}`),
    params: paramInfos,
    ret,
    owner: options.owner,
    isStatic: options.isStatic ?? false,
    isVirtual: options.isVirtual ?? false,
    isConst: options.isConst ?? false,
    isPure: false,
    isConstructor: false,
    isDestructor: false,
    isOverride: false,
    isFinal: false,
    access: 'public',
    row: -1,
    isAtomic: false,
    isDefined: true,
    native: run,
    nativeUses: options.uses,
    libraryConstant: options.libraryConstant,
    constantAccess: options.constantAccess,
    isVariadic: options.isVariadic,
    isExplicit: options.isExplicit,
  };
}

/** A constructor of a library class. */
export function nativeConstructor(
  cls: ClassInfo,
  params: Type[],
  run: NativeFunction,
  options: NativeOptions = {}
): FunctionInfo {
  return { ...native(cls.name, params, classType(cls), run, { ...options, owner: cls }), isConstructor: true };
}

/** A library function template, whose instance a call's arguments decide. */
export function generic(
  name: string,
  instantiate: FunctionInfo['instantiate'],
  displayName = `std::${name}`
): FunctionInfo {
  return { ...native(name, [], { kind: 'void' }, () => {}, { displayName }), instantiate, isTemplate: true };
}

export function addMethod(cls: ClassInfo, fn: FunctionInfo): void {
  fn.owner = cls;
  fn.displayName = `${cls.name}::${fn.name}`;
  const overloads = cls.methods.get(fn.name) ?? [];
  overloads.push(fn);
  cls.methods.set(fn.name, overloads);
}

export function constRef(type: Type): Type {
  return referenceTo(withConst(type));
}

export const CONST_CHAR_PTR: Type = { kind: 'pointer', to: CONST_CHAR };

/** Throws a library exception, such as the `std::out_of_range` of `vector::at`, or ends the program if uncaught. */
export function throwLibrary(frame: Frame, cls: ClassInfo, message: string): never {
  const object = new CObject(cls, []);
  object.message = message;
  return frame.runtime.throwException(frame, new CppException(object, classType(cls)));
}

/** Reads up to `limit` bytes from a character buffer, stopping at a null byte. */
export function readCString(pointer: Ptr, limit = Number.POSITIVE_INFINITY, runtime?: Runtime): string {
  const store = pointer.target();
  const start = pointer.index;
  if (start < 0 || start >= store.length) throw new CppRuntimeError('unterminatedString');
  let bytes = '';
  const end = start + limit;
  for (let index = start; index < end; index++) {
    if ((index - start) % 64 === 0) runtime?.spend();
    if (index >= store.length) throw new CppRuntimeError('unterminatedString');
    const value = store.get(index) as number;
    if (value === 0) return bytes;
    bytes += String.fromCodePoint(value & 0xff);
  }
  return bytes;
}

/** A new null-terminated array of `char` holding bytes, as `c_str()` and `what()` return. */
export function cStringStore(bytes: string): ArrayStore {
  const values: Value[] = [];
  for (let index = 0; index < bytes.length; index++) values.push(signedChar(byteAt(bytes, index)));
  values.push(0);
  const store = new ArrayStore(values, CONST_CHAR);
  store.isLiteral = true;
  return store;
}

export function signedChar(code: number): number {
  const byte = code & 0xff;
  return byte >= 128 ? byte - 256 : byte;
}

export function asNumber(value: unknown): number {
  return Number(value as number | bigint);
}
