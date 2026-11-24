import { FUNCTION_TYPE, IO_TYPE } from './builtinTypes';
import type { Role, TypeEntity } from './entities';
import { prune, splitApp, type Type } from './types';

const ORDER: Record<Role, number> = { phantom: 0, representational: 1, nominal: 2 };

/** The stricter of two roles. */
export function stricterRole(a: Role, b: Role): Role {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Whether a role allows no more conversions than another. */
export function atLeastAsStrict(role: Role, than: Role): boolean {
  return ORDER[role] >= ORDER[than];
}

/** The roles a `type role` annotation gives a type's parameters, which inference takes as their least roles. */
const annotated = new WeakMap<TypeEntity, (Role | undefined)[]>();
const inProgress = new Set<TypeEntity>();

export function annotateRoles(entity: TypeEntity, roles: (Role | undefined)[]): void {
  annotated.set(entity, roles);
  entity.roles = undefined;
}

/**
 * The roles of a type's parameters: a parameter that only fields of representational positions use is
 * representational, one no field uses is phantom, and one a type family, a constraint, a GADT's result type, or an
 * applied type variable uses is nominal.
 */
export function rolesOf(entity: TypeEntity): Role[] {
  if (entity.roles) return entity.roles;
  if (entity === IO_TYPE) return ['representational'];
  if (entity === FUNCTION_TYPE) return ['representational', 'representational'];
  const fixed = annotated.get(entity);
  const roles: Role[] = Array.from({ length: entity.arity }, (_, index) => fixed?.[index] ?? 'phantom');
  if (entity.sort !== 'data' || entity.dataFamily) return roles.fill('nominal');
  if (inProgress.has(entity)) return roles;
  inProgress.add(entity);
  try {
    // A recursive type refers to its own roles, which grow until they stop changing.
    for (let round = 0; round <= entity.arity; round++) {
      entity.roles = [...roles];
      const before = roles.join(',');
      inferInto(entity, roles);
      if (roles.join(',') === before) break;
    }
  } finally {
    inProgress.delete(entity);
  }
  entity.roles = roles;
  return roles;
}

/** The roles a type's declaration itself requires, without its annotation, which the annotation may only tighten. */
export function inferredRoles(entity: TypeEntity): Role[] {
  const roles: Role[] = Array.from({ length: entity.arity }, () => 'phantom');
  inferInto(entity, roles);
  return roles;
}

function inferInto(entity: TypeEntity, roles: Role[]): void {
  const mark = (index: number, role: Role): void => {
    if (index < roles.length) roles[index] = stricterRole(roles[index], role);
  };
  for (const con of entity.cons) {
    if (con.instanceArgs) {
      roles.fill('nominal');
      return;
    }
    for (const [index] of con.equalities ?? []) mark(index, 'nominal');
    for (const pred of con.context ?? []) walk(pred.type, 'nominal', mark);
    for (const field of con.fieldTypes) walk(field, 'representational', mark);
  }
}

function walk(type: Type, role: Role, mark: (index: number, role: Role) => void): void {
  if (role === 'phantom') return;
  const current = prune(type);
  switch (current.tag) {
    case 'tgen': {
      mark(current.index, role);
      return;
    }
    case 'forall': {
      for (const pred of current.preds) walk(pred.type, 'nominal', mark);
      walk(current.body, role, mark);
      return;
    }
    case 'tap': {
      const { head, args } = splitApp(current);
      if (head.tag !== 'tcon' || head.entity.sort === 'family' || head.entity.special === 'classArguments') {
        walk(head, role, mark);
        for (const arg of args) walk(arg, 'nominal', mark);
        return;
      }
      const headRoles = rolesOf(head.entity);
      for (const [index, arg] of args.entries()) {
        const argRole = headRoles[index] ?? 'nominal';
        walk(arg, argRole === 'representational' ? role : argRole, mark);
      }
      return;
    }
    default: {
      return;
    }
  }
}
