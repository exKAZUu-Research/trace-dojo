import type { Type } from './types';

export interface TypeSource {
  operand: number;
  path: number[];
}

export function findTypeSource(target: Type, operands: readonly Type[]): TypeSource | undefined {
  for (const [operand, type] of operands.entries()) {
    const pending = [{ type, path: [] as number[] }];
    const seen = new Set<Type>();
    while (pending.length > 0) {
      const current = pending.pop() as { type: Type; path: number[] };
      if (current.type === target) return { operand, path: current.path };
      if (seen.has(current.type)) continue;
      seen.add(current.type);
      for (const [index, child] of children(current.type).entries()) {
        pending.push({ type: child, path: [...current.path, index] });
      }
    }
  }
  return undefined;
}

export function typeFromSource(source: TypeSource, operands: readonly Type[]): Type | undefined {
  let type: Type | undefined = operands[source.operand];
  for (const index of source.path) {
    if (!type) return undefined;
    type = children(type)[index];
  }
  return type;
}

function children(type: Type): Type[] {
  switch (type.kind) {
    case 'named': {
      return [...(type.typeArgs ?? []), type.underlying];
    }
    case 'pointer':
    case 'slice':
    case 'array':
    case 'chan': {
      return [type.element];
    }
    case 'map': {
      return [type.key, type.value];
    }
    case 'struct': {
      return type.fields.map((field) => field.type);
    }
    case 'func': {
      return [...type.params, ...type.results];
    }
    case 'tuple': {
      return type.types;
    }
    case 'interface': {
      return [...type.methods.map((method) => method.type), ...(type.typeSet?.terms?.map((term) => term.type) ?? [])];
    }
    default: {
      return [];
    }
  }
}
