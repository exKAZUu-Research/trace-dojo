import type { PathRes } from './annotations';
import type { Pattern } from './ast';
import type { Checker } from './checker';
import type { Known } from './constLint';
import { normalize } from './infer';
import { compileError, lookupValue } from './items';
import { adt, freshVar, integerConst, shallow, substitute, type Type } from './types';

/** A single name in a pattern that names a unit variant, a unit struct, or a constant, rather than a new binding. */
export function patternBindingRes(c: Checker, pattern: Extract<Pattern, { kind: 'binding' }>): PathRes | undefined {
  if (pattern.sub || pattern.mutable || pattern.byRef) return undefined;
  const binding = lookupValue(c.body.module, pattern.name, pattern.span);
  if (!binding) return undefined;
  if (binding.kind === 'ctor') {
    const variant = binding.def.variants[binding.variant];
    if (variant.shape !== 'unit') {
      compileError(pattern.span, `${variant.name} はフィールドを持つので、${variant.name}(..) の形で書いてください。`);
    }
    return {
      kind: 'ctor',
      def: binding.def,
      variant: binding.variant,
      typeArgs: binding.def.params.map(() => freshVar()),
    };
  }
  if (binding.kind === 'const') return { kind: 'const', def: binding.def, type: binding.def.type, typeArgs: [] };
  return undefined;
}

/** A path pattern: a constant, a numeric constant of the standard library (`i32::MAX`), or a unit variant or struct. */
export function pathPattern(c: Checker, pattern: Extract<Pattern, { kind: 'path' }>, res: PathRes, t: Type): void {
  if (res.kind === 'const') {
    checkConstPattern(c, pattern, res, t);
    return;
  }
  if (res.kind === 'builtinConst' && res.type.kind !== 'float') {
    c.unifyOrError(pattern.span, t, res.type);
    c.annotations.constPatterns.set(pattern, res.type.kind === 'char' ? '\u{10FFFF}' : integerConst(res.name));
    return;
  }
  if (res.kind !== 'ctor' || res.def.variants[res.variant].shape !== 'unit') {
    compileError(pattern.span, `${pattern.path.segments.map((s) => s.name).join('::')} はパターンに書けません。`);
  }
  c.unifyOrError(pattern.span, t, adt(res.def, res.typeArgs));
}

export function checkConstPattern(c: Checker, pattern: Pattern, res: PathRes, t: Type): void {
  if (res.kind === 'ctor') {
    c.unifyOrError(pattern.span, t, adt(res.def, res.typeArgs));
  } else if (res.kind === 'const') {
    c.unifyOrError(pattern.span, t, res.type);
    c.requireTrait(res.type, 'PartialEq', pattern.span);
    c.annotations.constPatterns.set(pattern, undefined);
    c.deferCoverage(() => {
      const value = c.annotations.constPatterns.get(pattern);
      if (containsNaN(value)) compileError(pattern.span, 'NaN を含む定数はパターンに書けません。');
      if (!structuralValue(res.type, value)) {
        compileError(pattern.span, 'パターンに書く定数の型には、#[derive(PartialEq)] が必要です。');
      }
    }, pattern);
  }
}

const STRUCTURAL_BUILTINS = new Set([
  'Option',
  'Result',
  'Ordering',
  'Reverse',
  'Range',
  'RangeInclusive',
  'RangeFrom',
  'RangeTo',
  'RangeToInclusive',
  'RangeFull',
]);

function containsNaN(value: Known | undefined): boolean {
  if (typeof value === 'number') return Number.isNaN(value);
  return typeof value === 'object' && [...value.fields.values()].some(containsNaN);
}

// code-gauge-allow functionCognitiveComplexity -- The active constructor and its nested fields decide pattern equality.
function structuralValue(type: Type, value: Known | undefined, depth = 0): boolean {
  if (depth >= 64) return false;
  const t = normalize(shallow(type));
  const fields = typeof value === 'object' ? value.fields : undefined;
  if (t.kind === 'ref') return structuralValue(t.target, value, depth + 1);
  if (t.kind === 'tuple')
    return t.elems.every((elem, index) => structuralValue(elem, fields?.get(String(index)), depth + 1));
  if (t.kind === 'array' || t.kind === 'slice') {
    if (fields) return [...fields.values()].every((item) => structuralValue(t.elem, item, depth + 1));
    return (t.kind === 'array' && t.len === 0) || structuralValue(t.elem, undefined, depth + 1);
  }
  if (t.kind !== 'adt') return t.kind !== 'dyn';
  if (!t.def.derives.has('PartialEq') && (!t.def.builtin || !STRUCTURAL_BUILTINS.has(t.def.builtin))) return false;
  const tag = typeof value === 'object' && value.ctor?.startsWith('v') ? Number(value.ctor.slice(1)) : undefined;
  const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
  return t.def.variants.every(
    (variant, index) =>
      (tag !== undefined && index !== tag) ||
      variant.fields.every((field) =>
        structuralValue(substitute(field.type, subst), fields?.get(field.name), depth + 1)
      )
  );
}
