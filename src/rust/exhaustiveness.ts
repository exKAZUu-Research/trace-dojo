import type { Annotations } from './annotations';
import type { Pattern } from './ast';
import { normalize } from './infer';
import { shallow, type Type } from './types';

/**
 * A pattern reduced to what decides matching: a constructor with subpatterns, or anything (a wildcard or binding).
 * Literals of types with infinitely many values are constructors that never cover their type.
 */
type Pat = { kind: 'any' } | { kind: 'ctor'; ctor: string; args: Pat[] } | { kind: 'or'; alts: Pat[] };

const ANY: Pat = { kind: 'any' };

/** Lowers a checked pattern, using the paths the checker resolved to tell variants from bindings. */
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of pattern or type.
// code-gauge-allow functionNcss 43 -- One case per kind of pattern or type.
export function lowerPattern(pattern: Pattern, annotations: Annotations): Pat {
  switch (pattern.kind) {
    case 'wild': {
      return ANY;
    }
    case 'binding': {
      const res = annotations.paths.get(pattern);
      if (res?.kind === 'ctor') return { kind: 'ctor', ctor: `v${res.variant}`, args: [] };
      if (res?.kind === 'const') return { kind: 'ctor', ctor: `const:${res.def.name}`, args: [] };
      return pattern.sub ? lowerPattern(pattern.sub, annotations) : ANY;
    }
    case 'lit': {
      const { expr } = pattern;
      if (expr.kind === 'bool') return { kind: 'ctor', ctor: String(expr.value), args: [] };
      const value = 'value' in expr ? String(expr.value) : '';
      return { kind: 'ctor', ctor: `lit:${value}`, args: [] };
    }
    case 'tuple': {
      return { kind: 'ctor', ctor: 'tuple', args: pattern.elems.map((elem) => lowerPattern(elem, annotations)) };
    }
    case 'tupleStruct': {
      const res = annotations.paths.get(pattern);
      const variant = res?.kind === 'ctor' ? res.variant : 0;
      return { kind: 'ctor', ctor: `v${variant}`, args: pattern.elems.map((elem) => lowerPattern(elem, annotations)) };
    }
    case 'struct': {
      const res = annotations.paths.get(pattern);
      if (res?.kind !== 'ctor') return ANY;
      const variant = res.def.variants[res.variant];
      const args = variant.fields.map((field) => {
        const sub = pattern.fields.find((f) => f.name === field.name);
        return sub ? lowerPattern(sub.pattern, annotations) : ANY;
      });
      return { kind: 'ctor', ctor: `v${res.variant}`, args };
    }
    case 'path': {
      const res = annotations.paths.get(pattern);
      if (res?.kind === 'ctor') return { kind: 'ctor', ctor: `v${res.variant}`, args: [] };
      if (res?.kind === 'const') return { kind: 'ctor', ctor: `const:${res.def.name}`, args: [] };
      return ANY;
    }
    case 'ref': {
      // References are transparent: types are matched through them.
      return lowerPattern(pattern.pattern, annotations);
    }
    case 'or': {
      return { kind: 'or', alts: pattern.alternatives.map((alt) => lowerPattern(alt, annotations)) };
    }
  }
}

/** The constructors of a type and their arities, or undefined for types with infinitely many values. */
function constructorsOf(type: Type): { ctor: string; types: Type[] }[] | undefined {
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'bool': {
      return [
        { ctor: 'true', types: [] },
        { ctor: 'false', types: [] },
      ];
    }
    case 'tuple': {
      return [{ ctor: 'tuple', types: t.elems }];
    }
    case 'ref': {
      return constructorsOf(t.target);
    }
    case 'adt': {
      if (t.def.builtin && !['Option', 'Result', 'Ordering', 'Reverse'].includes(t.def.builtin)) return undefined;
      const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
      return t.def.variants.map((variant) => ({
        ctor: `v${variant.index}`,
        types: variant.fields.map((field) => substituteParams(field.type, subst)),
      }));
    }
    default: {
      return undefined;
    }
  }
}

function substituteParams(type: Type, subst: Map<unknown, Type>): Type {
  const t = shallow(type);
  if (t.kind === 'param') return subst.get(t.param) ?? t;
  if (t.kind === 'tuple') return { kind: 'tuple', elems: t.elems.map((elem) => substituteParams(elem, subst)) };
  if (t.kind === 'ref') return { kind: 'ref', mutable: t.mutable, target: substituteParams(t.target, subst) };
  if (t.kind === 'adt') return { kind: 'adt', def: t.def, args: t.args.map((arg) => substituteParams(arg, subst)) };
  if (t.kind === 'array' || t.kind === 'slice') return { ...t, elem: substituteParams(t.elem, subst) };
  return t;
}

/** Expands or-patterns at the head of a row. */
function expandRow(row: Pat[]): Pat[][] {
  const [head, ...rest] = row;
  if (head?.kind === 'or') return head.alts.flatMap((alt) => expandRow([alt, ...rest]));
  return [row];
}

/** Whether a vector of patterns matches some value that no row matches (Maranget's usefulness). */
// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of pattern or type.
// code-gauge-allow functionNcss 36 -- One case per kind of pattern or type.
function useful(rows: Pat[][], vector: Pat[], types: Type[], depth = 0): Pat[] | undefined {
  if (depth > 64) return undefined;
  if (vector.length === 0) return rows.length === 0 ? [] : undefined;
  const expanded = rows.flatMap(expandRow);
  const [head, ...rest] = vector;
  const [type, ...restTypes] = types;
  if (head.kind === 'or') {
    for (const alt of head.alts) {
      const witness = useful(expanded, [alt, ...rest], types, depth + 1);
      if (witness) return witness;
    }
    return undefined;
  }
  const ctors = constructorsOf(type);
  if (head.kind === 'ctor') {
    const arity = head.args.length;
    const subTypes = ctors?.find((c) => c.ctor === head.ctor)?.types ?? head.args.map(() => type);
    const specialized = specialize(expanded, head.ctor, arity);
    const witness = useful(specialized, [...head.args, ...rest], [...subTypes, ...restTypes], depth + 1);
    return witness && [{ kind: 'ctor', ctor: head.ctor, args: witness.slice(0, arity) }, ...witness.slice(arity)];
  }
  // A wildcard: useful if some constructor is missing from the rows' heads, or useful under one constructor.
  const heads = new Set(expanded.flatMap((row) => (row[0]?.kind === 'ctor' ? [row[0].ctor] : [])));
  if (ctors && ctors.every((c) => heads.has(c.ctor))) {
    for (const ctor of ctors) {
      const arity = ctor.types.length;
      const specialized = specialize(expanded, ctor.ctor, arity);
      const witness = useful(
        specialized,
        [...ctor.types.map(() => ANY), ...rest],
        [...ctor.types, ...restTypes],
        depth + 1
      );
      if (witness) return [{ kind: 'ctor', ctor: ctor.ctor, args: witness.slice(0, arity) }, ...witness.slice(arity)];
    }
    return undefined;
  }
  const defaults = expanded.filter((row) => row[0]?.kind === 'any').map((row) => row.slice(1));
  const witness = useful(defaults, rest, restTypes, depth + 1);
  if (!witness) return undefined;
  const missing = ctors?.find((c) => !heads.has(c.ctor));
  return [missing ? { kind: 'ctor', ctor: missing.ctor, args: missing.types.map(() => ANY) } : ANY, ...witness];
}

function specialize(rows: Pat[][], ctor: string, arity: number): Pat[][] {
  const result: Pat[][] = [];
  for (const row of rows) {
    const [head, ...rest] = row;
    if (head.kind === 'any') result.push([...Array.from({ length: arity }, () => ANY), ...rest]);
    else if (head.kind === 'ctor' && head.ctor === ctor) result.push([...head.args, ...rest]);
  }
  return result;
}

/** A pattern no arm matches, described for a message, or undefined when the arms cover every value. */
export function missingPattern(patterns: Pat[], type: Type): string | undefined {
  const witness = useful(
    patterns.map((pattern) => [pattern]),
    [ANY],
    [type]
  );
  if (!witness) return undefined;
  return describe(witness[0], type);
}

/** Whether a pattern matches every value of its type, as `let` requires. */
export function isIrrefutable(pattern: Pat, type: Type): boolean {
  return missingPattern([pattern], type) === undefined;
}

function describe(pattern: Pat, type: Type): string {
  if (pattern.kind !== 'ctor') return '_';
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (pattern.ctor === 'true' || pattern.ctor === 'false') return pattern.ctor;
  const ctors = constructorsOf(t);
  const types = ctors?.find((c) => c.ctor === pattern.ctor)?.types ?? [];
  const args = pattern.args.map((arg, index) => describe(arg, types[index] ?? t));
  if (pattern.ctor === 'tuple') return `(${args.join(', ')})`;
  if (pattern.ctor === 'ref') return `&${args[0]}`;
  if (t.kind === 'adt' && pattern.ctor.startsWith('v')) {
    const variant = t.def.variants[Number(pattern.ctor.slice(1))];
    const name =
      t.def.kind === 'enum' && !['Option', 'Result'].includes(t.def.builtin ?? '')
        ? `${t.def.name}::${variant.name}`
        : variant.name;
    if (variant.shape === 'tuple') return `${name}(${args.join(', ')})`;
    if (variant.shape === 'named') return `${name} { .. }`;
    return name;
  }
  return '_';
}
