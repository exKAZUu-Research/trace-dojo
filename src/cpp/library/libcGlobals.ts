import { type ClassInfo, type FunctionInfo, type Type, typeName, unqualified } from '../types';
import sdk from './libcGlobalDeclarations.json';
import members from './libcMembers.json';

const declarations: Readonly<Record<string, (string | number)[][]>> = sdk.declarations;
const types: Readonly<Record<string, number>> = sdk.types;
const macros: Readonly<Record<string, number>> = sdk.macros;
const functionMacros: Readonly<Record<string, number>> = sdk.functionMacros;
const standard: Readonly<Record<string, (number | string)[][]>> = sdk.standard;
const stdDefinitions: Readonly<Record<string, number>> = sdk.stdDefinitions;
const sdkMembers: Readonly<Record<string, readonly string[]>> = members;
type MathWrapper = 'integer' | 'float' | 'double' | 'ldouble';
const mathCalls: Readonly<Record<string, Partial<Record<MathWrapper, string>>>> = sdk.mathCalls;
type FloatingWrapper = Exclude<MathWrapper, 'integer'>;
const mathNaNResults: Readonly<Record<string, Partial<Record<FloatingWrapper, string>>>> = sdk.mathNaNResults;
const headerGroups = sdk.headers.map((group) => new Set(group));

export function conflictsWithLibcGlobal(
  name: string,
  entity: Type | FunctionInfo,
  headers: ReadonlySet<string>
): boolean {
  if (!Object.hasOwn(declarations, name)) return false;
  const isVariable = 'kind' in entity;
  for (const [group, kind, signature] of declarations[name]) {
    if (typeof group !== 'number' || typeof signature !== 'string') continue;
    if (!visibleIn(group, headers)) continue;
    if (isVariable) {
      if (kind !== 'var' || compact(typeName(entity)) !== compact(signature)) return true;
    } else if (
      kind === 'var' ||
      hasConflictingSignature(entity, kind === 'using' || (kind === 'definition' && entity.isDefined), signature)
    ) {
      return true;
    }
  }
  return false;
}

export function isLibcHeaderMacro(name: string, headers: ReadonlySet<string>): boolean {
  return Object.hasOwn(macros, name) && visibleIn(macros[name], headers);
}

export function isLibcFunctionMacro(name: string, headers: ReadonlySet<string>): boolean {
  return Object.hasOwn(functionMacros, name) && visibleIn(functionMacros[name], headers);
}

export function isSdkGlobalType(name: string, headers: ReadonlySet<string>): boolean {
  return Object.hasOwn(types, name) && visibleIn(types[name], headers);
}

export function isLibcGlobalDeclared(name: string, headers: ReadonlySet<string>): boolean {
  return (
    Object.hasOwn(declarations, name) &&
    declarations[name].some(([group]) => typeof group === 'number' && visibleIn(group, headers))
  );
}

export function redeclaresLibcFunction(fn: FunctionInfo, headers: ReadonlySet<string>): boolean {
  if (!Object.hasOwn(declarations, fn.name)) return false;
  return declarations[fn.name].some(
    ([group, kind, signature]) =>
      typeof group === 'number' &&
      (kind === 'function' || kind === 'definition') &&
      typeof signature === 'string' &&
      visibleIn(group, headers) &&
      matchingReturnType(fn, signature) &&
      matchingParameters(fn, signature)
  );
}

export function conflictsWithStdName(name: string, isFunction: boolean, headers: ReadonlySet<string>): boolean {
  return (
    Object.hasOwn(standard, name) &&
    standard[name].some(
      ([group, kind]) => typeof group === 'number' && (!isFunction || kind === 'other') && visibleIn(group, headers)
    )
  );
}

export function isSdkStdDeclared(name: string, headers: ReadonlySet<string>, kind?: 'function' | 'template'): boolean {
  return (
    Object.hasOwn(standard, name) &&
    standard[name].some(
      ([group, declared]) => typeof group === 'number' && (!kind || kind === declared) && visibleIn(group, headers)
    )
  );
}

export function isSdkStdForwardOnly(name: string, headers: ReadonlySet<string>): boolean {
  return Object.hasOwn(stdDefinitions, name) && !visibleIn(stdDefinitions[name], headers);
}

export function isSdkMemberDeclared(cls: ClassInfo, name: string): boolean {
  const key = cls.library?.sdkMemberClass ?? cls.library?.kind;
  if (key && Object.hasOwn(sdkMembers, key) && sdkMembers[key].includes(name)) return true;
  if (cls.base && isSdkMemberDeclared(cls.base, name)) return true;
  return cls.library?.additionalPublicBases?.some((base) => isSdkMemberDeclared(base, name)) === true;
}

export function mathWrapperCall(name: string, kind: MathWrapper): string | undefined {
  return Object.hasOwn(mathCalls, name) ? mathCalls[name][kind] : undefined;
}

export function mathWrapperNaNResults(name: string, kind: FloatingWrapper): string | undefined {
  return Object.hasOwn(mathNaNResults, name) ? mathNaNResults[name][kind] : undefined;
}

function visibleIn(group: number, headers: ReadonlySet<string>): boolean {
  return [...headers].some((header) => headerGroups[group].has(header));
}

function hasConflictingSignature(declared: FunctionInfo, cannotRedeclare: boolean, signature: string): boolean {
  return matchingParameters(declared, signature) && (cannotRedeclare || !matchingReturnType(declared, signature));
}

function matchingParameters(declared: FunctionInfo, signature: string): boolean {
  const paramsStart = signature.indexOf('(');
  if (paramsStart === -1) return false;
  const params = declared.params.map(({ type }) => typeName(unqualified(type)));
  if (declared.isVariadic) params.push('...');
  return compact(`(${params.join(',')})`) === compact(signature.slice(paramsStart));
}

function matchingReturnType(declared: FunctionInfo, signature: string): boolean {
  return compact(typeName(declared.ret)) === compact(signature.slice(0, signature.indexOf('(')));
}

/** A type as signatures compare it: without spaces or `struct`, and naming the SDK's `__sFILE` as the interpreter's `FILE`. */
function compact(type: string): string {
  return type
    .replaceAll(/\bstruct\s+/g, '')
    .replaceAll(/\s+/g, '')
    .replaceAll('__sFILE', 'FILE');
}
