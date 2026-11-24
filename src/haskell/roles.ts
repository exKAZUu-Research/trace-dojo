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

export function annotateRoles(entity: TypeEntity, roles: (Role | undefined)[]): void {
  annotated.set(entity, roles);
  entity.roles = undefined;
}

type RolesOf = (entity: TypeEntity) => Role[];

/**
 * The roles of a type's parameters: a parameter that only fields of representational positions use is
 * representational, one no field uses is phantom, and one a type family, a constraint, a GADT's result type, or an
 * applied type variable uses is nominal. Types that refer to each other get their roles together, growing from
 * their least roles until none changes, so that which of them is asked first does not matter.
 */
export function rolesOf(entity: TypeEntity): Role[] {
  if (entity.roles) return entity.roles;
  if (entity === IO_TYPE) return ['representational'];
  if (entity === FUNCTION_TYPE) return ['representational', 'representational'];
  if (!inferable(entity)) {
    entity.roles = Array.from({ length: entity.arity }, () => 'nominal');
    return entity.roles;
  }
  const group = uncachedGroup(entity);
  const table = new Map(group.map((member) => [member, leastRoles(member)]));
  const lookup: RolesOf = (other) => table.get(other) ?? rolesOf(other);
  for (let changed = true; changed;) {
    changed = false;
    for (const [member, roles] of table) {
      const before = roles.join(',');
      inferInto(member, roles, lookup);
      if (roles.join(',') !== before) changed = true;
    }
  }
  for (const [member, roles] of table) member.roles = roles;
  return table.get(entity) as Role[];
}

function inferable(entity: TypeEntity): boolean {
  return entity.sort === 'data' && !entity.dataFamily;
}

function leastRoles(entity: TypeEntity): Role[] {
  const fixed = annotated.get(entity);
  return Array.from({ length: entity.arity }, (_, index) => fixed?.[index] ?? 'phantom');
}

/** The data types without known roles that a type's fields reach, which share the computation of their roles. */
function uncachedGroup(entity: TypeEntity): TypeEntity[] {
  const group: TypeEntity[] = [];
  const pending = [entity];
  while (pending.length > 0) {
    const current = pending.pop() as TypeEntity;
    if (group.includes(current) || current.roles || !inferable(current)) continue;
    group.push(current);
    for (const con of current.cons) {
      for (const type of [...con.fieldTypes, ...(con.context ?? []).map((pred) => pred.type)]) {
        pending.push(...typeHeads(type));
      }
    }
  }
  return group;
}

function typeHeads(type: Type): TypeEntity[] {
  const current = prune(type);
  if (current.tag === 'tcon') return [current.entity];
  if (current.tag === 'tap') return [...typeHeads(current.fn), ...typeHeads(current.arg)];
  if (current.tag === 'forall') return typeHeads(current.body);
  return [];
}

/** The roles a type's declaration itself requires, without its annotation, which the annotation may only tighten. */
export function inferredRoles(entity: TypeEntity): Role[] {
  const roles: Role[] = Array.from({ length: entity.arity }, () => 'phantom');
  inferInto(entity, roles, rolesOf);
  return roles;
}

function inferInto(entity: TypeEntity, roles: Role[], lookup: RolesOf): void {
  const mark = (index: number, role: Role): void => {
    if (index < roles.length) roles[index] = stricterRole(roles[index], role);
  };
  for (const con of entity.cons) {
    if (con.instanceArgs) {
      roles.fill('nominal');
      return;
    }
    for (const [index] of con.equalities ?? []) mark(index, 'nominal');
    for (const pred of con.context ?? []) walk(pred.type, 'nominal', mark, lookup);
    for (const field of con.fieldTypes) walk(field, 'representational', mark, lookup);
  }
}

function walk(type: Type, role: Role, mark: (index: number, role: Role) => void, lookup: RolesOf): void {
  if (role === 'phantom') return;
  const current = prune(type);
  switch (current.tag) {
    case 'tgen': {
      mark(current.index, role);
      return;
    }
    case 'forall': {
      for (const pred of current.preds) walk(pred.type, 'nominal', mark, lookup);
      walk(current.body, role, mark, lookup);
      return;
    }
    case 'tap': {
      const { head, args } = splitApp(current);
      if (head.tag !== 'tcon' || head.entity.sort === 'family' || head.entity.special === 'classArguments') {
        walk(head, role, mark, lookup);
        for (const arg of args) walk(arg, 'nominal', mark, lookup);
        return;
      }
      const headRoles = lookup(head.entity);
      for (const [index, arg] of args.entries()) {
        const argRole = headRoles[index] ?? 'nominal';
        walk(arg, argRole === 'representational' ? role : argRole, mark, lookup);
      }
      return;
    }
    default: {
      return;
    }
  }
}
