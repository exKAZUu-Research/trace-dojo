import type { LocalVar, PathRes } from './annotations';
import type { Pattern } from './ast';
import type { Checker } from './checker';
import { resolveStructPath, resolveValuePath } from './checkerPaths';
import { checkFieldVisible } from './checkerPlaces';
import { normalize } from './infer';
import { compileError, lookupValue } from './items';
import { adt, freshVar, ref, resolve, shallow, substitute, type Type, typeToString } from './types';

/**
 * Checks a pattern against the type of the value it matches, declaring its bindings. Matching a reference with a
 * pattern that is not a reference pattern looks through it and binds by reference, as Rust's match ergonomics do.
 */
/** `inherited`: the outer reference of `type` is the one a default binding mode gives the field (`ref`). */
export function checkPattern(
  c: Checker,
  pattern: Pattern,
  type: Type,
  mode: LocalVar['mode'],
  inherited = false
): void {
  pattern.ty = type;
  const t = normalize(shallow(type));
  switch (pattern.kind) {
    case 'wild': {
      return;
    }
    case 'binding': {
      bindingPattern(c, pattern, type, t, mode);
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
  mode: LocalVar['mode']
): void {
  const binding = patternBindingRes(c, pattern);
  if (binding) {
    c.annotations.paths.set(pattern, binding);
    checkConstPattern(c, pattern, binding, derefForMatch(t, mode).t);
    return;
  }
  const localType = mode === 'move' ? type : ref(t, mode === 'refMut');
  const existing = c.orBindings?.get(pattern.name);
  if (existing) {
    c.unifyOrError(pattern.span, existing.type, localType);
    c.annotations.bindings.set(pattern, existing);
    (c.body.scopes.at(-1) as Map<string, LocalVar>).set(pattern.name, existing);
    return;
  }
  const local = c.declareLocal(pattern.name, localType, pattern.mutable, pattern.span, mode);
  if (pattern.mutable && mode !== 'move') {
    compileError(pattern.span, '参照に合わせたパターンの名前には、mut を付けられません。');
  }
  c.annotations.bindings.set(pattern, local);
  if (pattern.sub) checkPattern(c, pattern.sub, type, mode);
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
    checkPattern(
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
  checkPattern(c, pattern.pattern, target, 'move');
  c.deferredChecks.push(() => {
    if (
      pattern.pattern.kind === 'binding' &&
      !c.annotations.paths.has(pattern.pattern) &&
      !c.solver.isCopy(resolve(target, true))
    ) {
      c.patternMoves.push({
        span: pattern.span,
        message: `& のパターンで取り出すと値が動くので、${typeToString(resolve(target))} には使えません（& を外してください）。`,
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
      const before = new Set(c.body.fn.locals);
      checkPattern(c, alternative, type, mode);
      if (index === 0) {
        for (const local of c.body.fn.locals) if (!before.has(local)) bindings.set(local.name, local);
      } else {
        requireSameBindings(alternative, bindings);
      }
    }
  } finally {
    c.orBindings = outer;
  }
}

function requireSameBindings(alternative: Pattern, bindings: Map<string, LocalVar>): void {
  const names = new Set(collectBindingNames(alternative));
  for (const name of bindings.keys()) {
    if (!names.has(name)) compileError(alternative.span, `| のどちらのパターンにも、${name} を書いてください。`);
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
  }
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
      c.unifyOrError(pattern.span, t, res.type);
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
      checkPattern(c, elem, fieldType(index), subMode, bindingMode !== 'move');
    }
    return;
  }
  if (variant.shape !== 'named')
    compileError(pattern.span, `${variant.name} は ${variant.name} { .. } の形では書けません。`);
  const seen = new Set<string>();
  for (const field of pattern.fields) {
    const index = variant.fields.findIndex((f) => f.name === field.name);
    if (index === -1) compileError(field.span, `${variant.name} にフィールド ${field.name} がありません。`);
    seen.add(field.name);
    if (res.def.kind === 'struct') checkFieldVisible(c, res.def, variant.fields[index], field.span);
    checkPattern(c, field.pattern, fieldType(index), subMode, bindingMode !== 'move');
  }
  const missing = variant.fields.filter((f) => !seen.has(f.name));
  if (missing.length > 0) {
    compileError(pattern.span, `パターンにフィールド ${missing.map((f) => f.name).join(', ')} が足りません。`);
  }
}

function collectBindingNames(pattern: Pattern): string[] {
  switch (pattern.kind) {
    case 'binding': {
      return [pattern.name, ...(pattern.sub ? collectBindingNames(pattern.sub) : [])];
    }
    case 'tuple':
    case 'tupleStruct': {
      return pattern.elems.flatMap(collectBindingNames);
    }
    case 'struct': {
      return pattern.fields.flatMap((field) => collectBindingNames(field.pattern));
    }
    case 'ref': {
      return collectBindingNames(pattern.pattern);
    }
    case 'or': {
      return collectBindingNames(pattern.alternatives[0]);
    }
    default: {
      return [];
    }
  }
}
