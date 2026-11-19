import { type FunctionInfo, type Type, typeName, unqualified } from '../types';
import sdk from './libcGlobalDeclarations.json';

const declarations: Readonly<Record<string, (string | number)[][]>> = sdk.declarations;
const macros: Readonly<Record<string, number>> = sdk.macros;
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

export function isLibcGlobalDeclared(name: string, headers: ReadonlySet<string>): boolean {
  return (
    Object.hasOwn(declarations, name) &&
    declarations[name].some(([group]) => typeof group === 'number' && visibleIn(group, headers))
  );
}

function visibleIn(group: number, headers: ReadonlySet<string>): boolean {
  return [...headers].some((header) => headerGroups[group].has(header));
}

function hasConflictingSignature(declared: FunctionInfo, cannotRedeclare: boolean, signature: string): boolean {
  const paramsStart = signature.indexOf('(');
  if (paramsStart === -1) return false;
  const params = declared.params.map(({ type }) => typeName(unqualified(type)));
  if (declared.isVariadic) params.push('...');
  if (compact(`(${params.join(',')})`) !== compact(signature.slice(paramsStart))) return false;
  return cannotRedeclare || compact(typeName(declared.ret)) !== compact(signature.slice(0, paramsStart));
}

function compact(type: string): string {
  return type.replaceAll(/\s+/g, '');
}
