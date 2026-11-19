import { type FunctionInfo, type Type, typeName, unqualified } from '../types';
import sdk from './libcGlobalDeclarations.json';

const declarations: Readonly<Record<string, (string | number)[][]>> = sdk.declarations;
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
    if (![...headers].some((header) => headerGroups[group].has(header))) continue;
    if (isVariable) {
      if (kind !== 'var' || compact(typeName(entity)) !== compact(signature)) return true;
    } else if (kind === 'var' || hasConflictingSignature(entity, kind === 'using', signature)) {
      return true;
    }
  }
  return false;
}

function hasConflictingSignature(declared: FunctionInfo, fromUsingDeclaration: boolean, signature: string): boolean {
  const paramsStart = signature.indexOf('(');
  if (paramsStart === -1) return false;
  const params = declared.params.map(({ type }) => typeName(unqualified(type)));
  if (declared.isVariadic) params.push('...');
  if (compact(`(${params.join(',')})`) !== compact(signature.slice(paramsStart))) return false;
  return fromUsingDeclaration || compact(typeName(declared.ret)) !== compact(signature.slice(0, paramsStart));
}

function compact(type: string): string {
  return type.replaceAll(/\s+/g, '');
}
