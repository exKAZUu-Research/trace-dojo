import type { LocalVar, PathRes } from './annotations';
import type { Pattern } from './ast';
import { patternBindings } from './astWalk';
import type { Checker } from './checker';
import { resolveStructPath, resolveValuePath } from './checkerPaths';
import { checkFieldVisible } from './checkerPlaces';
import { ConstLint, type Known } from './constLint';
import { normalize } from './infer';
import { compileError, lookupValue } from './items';
import { adt, freshVar, ref, resolve, shallow, substitute, type Type, typeToString } from './types';

export function checkPattern(c: Checker, pattern: Pattern, type: Type, mode: LocalVar['mode']): void {
  checkPatternPart(c, pattern, type, mode);
  distinctBindings(c, pattern);
}

function distinctBindings(c: Checker, pattern: Pattern): Set<string> {
  switch (pattern.kind) {
    case 'binding': {
      const names = pattern.sub ? distinctBindings(c, pattern.sub) : new Set<string>();
      if (c.annotations.bindings.has(pattern)) addBinding(names, pattern.name, pattern);
      return names;
    }
    case 'or': {
      const [first] = pattern.alternatives.map((part) => distinctBindings(c, part));
      return first ?? new Set();
    }
    case 'ref': {
      return distinctBindings(c, pattern.pattern);
    }
    case 'tuple':
    case 'tupleStruct':
    case 'struct': {
      const children = pattern.kind === 'struct' ? pattern.fields.map((field) => field.pattern) : pattern.elems;
      const names = new Set<string>();
      for (const child of children) {
        for (const name of distinctBindings(c, child)) addBinding(names, name, child);
      }
      return names;
    }
    default: {
      return new Set();
    }
  }
}

function addBinding(names: Set<string>, name: string, pattern: Pattern): void {
  if (names.has(name)) compileError(pattern.span, `パターンで ${name} が2回束縛されています。`);
  names.add(name);
}

/**
 * Checks a pattern against the type of the value it matches, declaring its bindings. Matching a reference with a
 * pattern that is not a reference pattern looks through it and binds by reference, as Rust's match ergonomics do.
 */
/** `inherited`: the outer reference of `type` is the one a default binding mode gives the field (`ref`). */
function checkPatternPart(c: Checker, pattern: Pattern, type: Type, mode: LocalVar['mode'], inherited = false): void {
  pattern.ty = type;
  const t = normalize(shallow(type));
  switch (pattern.kind) {
    case 'wild': {
      return;
    }
    case 'binding': {
      bindingPattern(c, pattern, type, t, mode, inherited);
      return;
    }
    case 'lit': {
      litPattern(c, pattern, type, t, inherited);
      return;
    }
    case 'tuple': {
      tuplePattern(c, pattern, type, t, mode);
      return;
    }
    case 'tupleStruct':
    case 'struct':
    case 'path': {
      const matched = derefForMatch(t, mode);
      adtPattern(c, pattern, matched.t, type, matched.bindingMode, mode);
      return;
    }
    case 'ref': {
      refPattern(c, pattern, type, t, mode, inherited);
      return;
    }
    case 'or': {
      orPattern(c, pattern, type, mode);
      return;
    }
  }
}

/** The type under the references a pattern that is not a reference pattern looks through, and the binding mode. */
function derefForMatch(type: Type, mode: LocalVar['mode']): { t: Type; bindingMode: LocalVar['mode'] } {
  let t = type;
  let bindingMode = mode;
  while (t.kind === 'ref') {
    bindingMode = t.mutable && bindingMode !== 'ref' ? 'refMut' : 'ref';
    t = normalize(shallow(t.target));
  }
  return { t, bindingMode };
}

function bindingPattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'binding' }>,
  type: Type,
  t: Type,
  mode: LocalVar['mode'],
  inherited: boolean
): void {
  const binding = patternBindingRes(c, pattern);
  const matched = derefForMatch(t, mode).t;
  if (binding) {
    c.annotations.paths.set(pattern, binding);
    checkConstPattern(c, pattern, binding, matched);
    return;
  }
  if (!inherited) checkVariantBinding(pattern, matched, mode);
  const localType = mode === 'move' ? type : ref(t, mode === 'refMut');
  const existing = c.orBindings?.get(pattern.name);
  if (existing) {
    if (existing.mode !== mode || existing.mutable !== pattern.mutable) {
      compileError(pattern.span, `| の各パターンで、${pattern.name} を同じ方法で束縛してください。`);
    }
    c.unifyOrError(pattern.span, existing.type, localType);
    c.annotations.bindings.set(pattern, existing);
    (c.body.scopes.at(-1) as Map<string, LocalVar>).set(pattern.name, existing);
    if (pattern.sub) checkPatternPart(c, pattern.sub, type, mode);
    return;
  }
  const local = c.declareLocal(pattern.name, localType, pattern.mutable, pattern.span, mode);
  if (pattern.mutable && mode !== 'move') {
    compileError(pattern.span, '参照に合わせたパターンの名前には、mut を付けられません。');
  }
  c.annotations.bindings.set(pattern, local);
  if (pattern.sub) checkPatternPart(c, pattern.sub, type, mode);
}

function checkVariantBinding(pattern: Extract<Pattern, { kind: 'binding' }>, type: Type, mode: LocalVar['mode']): void {
  if (pattern.mutable || pattern.sub || mode !== 'move' || type.kind !== 'adt' || type.def.kind !== 'enum') return;
  if (type.def.variants.some((variant) => variant.shape === 'unit' && variant.name === pattern.name)) {
    compileError(
      pattern.span,
      `パターンの名前 ${pattern.name} は列挙型の選択肢と同じです。${type.def.name}::${pattern.name} と書いてください。`
    );
  }
}

function litPattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'lit' }>,
  type: Type,
  outer: Type,
  inherited: boolean
): void {
  // A string literal is a reference, which rustc matches against the type as it is, without its references.
  if (pattern.expr.kind === 'str') strLiteralPattern(pattern, type, inherited);
  const { t } = derefForMatch(outer, 'move');
  const litType = c.expr(pattern.expr, t);
  if (pattern.expr.kind === 'str') {
    if (t.kind === 'adt' && t.def.builtin === 'String') {
      compileError(
        pattern.span,
        'String は文字列のリテラルのパターンと比べられません（.as_str() で &str にしてください）。'
      );
    }
    if (t.kind === 'str') {
      return;
    }
  }
  c.unifyOrError(pattern.span, t, litType);
}

function tuplePattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'tuple' }>,
  type: Type,
  outer: Type,
  mode: LocalVar['mode']
): void {
  let { t, bindingMode } = derefForMatch(outer, mode);
  if (t.kind === 'var') {
    const elems = pattern.elems.map(() => freshVar());
    c.unifier.unify(t, { kind: 'tuple', elems });
    t = normalize(shallow(t));
  }
  if (t.kind !== 'tuple' || t.elems.length !== pattern.elems.length) {
    compileError(
      pattern.span,
      `パターンの型が合いません（${typeToString(resolve(type))} にタプルのパターンは合いません）。`
    );
  }
  for (const [index, elem] of pattern.elems.entries()) {
    checkPatternPart(
      c,
      elem,
      bindingMode === 'move' ? t.elems[index] : ref(t.elems[index], bindingMode === 'refMut'),
      bindingMode === 'move' ? mode : 'move',
      bindingMode !== 'move'
    );
  }
}

function refPattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'ref' }>,
  type: Type,
  outer: Type,
  mode: LocalVar['mode'],
  inherited: boolean
): void {
  let t = outer;
  if (t.kind === 'var') {
    const inner = freshVar();
    c.unifier.unify(t, ref(inner, pattern.mutable));
    t = normalize(shallow(t));
  }
  if (t.kind !== 'ref')
    compileError(
      pattern.span,
      `& のパターンは、参照にだけ合います（${typeToString(resolve(type))} は参照ではありません）。`
    );
  if (pattern.mutable !== t.mutable) {
    compileError(
      pattern.span,
      `パターンの型が合いません（${typeToString(resolve(type))} に ${pattern.mutable ? '&mut' : '&'} のパターンは合いません）。`
    );
  }
  // Edition 2024 rejects `&` where the default binding mode borrows.
  if (mode !== 'move' || inherited) {
    compileError(pattern.span, '参照に合わせたパターンの中には、& のパターンを書けません。');
  }
  const target = t.target;
  checkPatternPart(c, pattern.pattern, target, 'move');
  c.deferredChecks.push(() => {
    for (const local of patternBindings(pattern.pattern, c.annotations)) {
      if (local.mode !== 'move' || c.solver.isCopy(resolve(local.type, true))) continue;
      c.patternMoves.push({
        span: local.span,
        message: `& のパターンで取り出すと値が動くので、${typeToString(resolve(local.type))} には使えません（& を外してください）。`,
      });
    }
  });
}

function orPattern(c: Checker, pattern: Extract<Pattern, { kind: 'or' }>, type: Type, mode: LocalVar['mode']): void {
  const outer = c.orBindings;
  const bindings = new Map<string, LocalVar>();
  c.orBindings = bindings;
  try {
    for (const [index, alternative] of pattern.alternatives.entries()) {
      checkPatternPart(c, alternative, type, mode);
      const locals = patternBindings(alternative, c.annotations);
      if (index === 0) {
        for (const local of locals) bindings.set(local.name, local);
      } else {
        requireSameBindings(alternative, bindings, locals);
      }
    }
  } finally {
    c.orBindings = outer;
  }
}

function requireSameBindings(alternative: Pattern, bindings: Map<string, LocalVar>, locals: LocalVar[]): void {
  const names = new Set(locals.map((local) => local.name));
  for (const name of bindings.keys()) {
    if (!names.has(name)) compileError(alternative.span, `| のどちらのパターンにも、${name} を書いてください。`);
  }
  for (const name of names) {
    if (!bindings.has(name)) compileError(alternative.span, `| のどちらのパターンにも、${name} を書いてください。`);
  }
}

/** A string literal pattern matches a `&str`, or a `str` behind it; a `&&str` it does not reach (E0308). */
function strLiteralPattern(pattern: Pattern, type: Type, inherited: boolean): void {
  let t = normalize(shallow(type));
  if (inherited && t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind !== 'ref') return;
  const target = normalize(shallow(t.target));
  if (target.kind === 'ref') {
    compileError(pattern.span, `型が合いません（${typeToString(resolve(type))} が必要ですが、&str です）。`);
  }
}

/** A single name in a pattern that names a unit variant, a unit struct, or a constant, rather than a new binding. */
function patternBindingRes(c: Checker, pattern: Extract<Pattern, { kind: 'binding' }>): PathRes | undefined {
  if (pattern.sub || pattern.mutable) return undefined;
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

function checkConstPattern(c: Checker, pattern: Pattern, res: PathRes, t: Type): void {
  if (res.kind === 'ctor') {
    c.unifyOrError(pattern.span, t, adt(res.def, res.typeArgs));
  } else if (res.kind === 'const') {
    c.unifyOrError(pattern.span, t, res.type);
    c.requireTrait(res.type, 'PartialEq', pattern.span);
    c.coverageChecks.push(() => {
      const value = ConstLint.patternValue(res.def, c.annotations);
      if (containsNaN(value)) compileError(pattern.span, 'NaN を含む定数はパターンに書けません。');
      if (!structuralValue(res.type, value)) {
        compileError(pattern.span, 'パターンに書く定数の型には、#[derive(PartialEq)] が必要です。');
      }
    });
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

// code-gauge-allow functionCognitiveComplexity 27 -- Follows the type checking rules of rustc case by case.
// code-gauge-allow functionNcss 49 -- Follows the type checking rules of rustc case by case.
function adtPattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'tupleStruct' | 'struct' | 'path' }>,
  t: Type,
  original: Type,
  bindingMode: LocalVar['mode'],
  mode: LocalVar['mode']
): void {
  let res: PathRes;
  if (pattern.kind === 'struct') {
    const found = resolveStructPath(c, pattern.path, pattern.span);
    res = { kind: 'ctor', ...found };
  } else {
    res = resolveValuePath(c, pattern.path, pattern.span);
  }
  c.annotations.paths.set(pattern, res);
  if (pattern.kind === 'path') {
    if (res.kind === 'const') {
      checkConstPattern(c, pattern, res, t);
      return;
    }
    if (res.kind !== 'ctor' || res.def.variants[res.variant].shape !== 'unit') {
      compileError(pattern.span, `${pattern.path.segments.map((s) => s.name).join('::')} はパターンに書けません。`);
    }
    c.unifyOrError(pattern.span, t, adt(res.def, res.typeArgs));
    return;
  }
  if (res.kind !== 'ctor') {
    compileError(
      pattern.span,
      `${pattern.path.segments.map((s) => s.name).join('::')} は列挙子や構造体ではありません。`
    );
  }
  const self = adt(res.def, res.typeArgs);
  if (!c.unifier.tryUnify(t, self)) {
    compileError(
      pattern.span,
      `パターンの型が合いません（${typeToString(resolve(original))} に ${res.def.name} のパターンは合いません）。`
    );
  }
  const variant = res.def.variants[res.variant];
  const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
  const fieldType = (index: number): Type => {
    const type = substitute(variant.fields[index].type, subst);
    return bindingMode === 'move' ? type : ref(type, bindingMode === 'refMut');
  };
  const subMode = bindingMode === 'move' ? mode : 'move';
  if (pattern.kind === 'tupleStruct') {
    if (variant.shape !== 'tuple')
      compileError(pattern.span, `${variant.name} は ${variant.name}(..) の形では書けません。`);
    if (pattern.elems.length !== variant.fields.length) {
      compileError(
        pattern.span,
        `${variant.name} のパターンの要素の数が合いません（${variant.fields.length} 個です）。`
      );
    }
    for (const [index, elem] of pattern.elems.entries()) {
      checkPatternPart(c, elem, fieldType(index), subMode, bindingMode !== 'move');
    }
    return;
  }
  if (variant.shape !== 'named')
    compileError(pattern.span, `${variant.name} は ${variant.name} { .. } の形では書けません。`);
  const seen = new Set<string>();
  for (const field of pattern.fields) {
    const index = variant.fields.findIndex((f) => f.name === field.name);
    if (index === -1) compileError(field.span, `${variant.name} にフィールド ${field.name} がありません。`);
    if (seen.has(field.name)) compileError(field.span, `フィールド ${field.name} が2回あります。`);
    seen.add(field.name);
    if (res.def.kind === 'struct') checkFieldVisible(c, res.def, variant.fields[index], field.span);
    checkPatternPart(c, field.pattern, fieldType(index), subMode, bindingMode !== 'move');
  }
  const missing = variant.fields.filter((f) => !seen.has(f.name));
  if (missing.length > 0) {
    compileError(pattern.span, `パターンにフィールド ${missing.map((f) => f.name).join(', ')} が足りません。`);
  }
}
