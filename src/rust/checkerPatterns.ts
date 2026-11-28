import type { LocalVar, PathRes } from './annotations';
import type { Expr, Pattern, Span } from './ast';
import { patternBindings } from './astWalk';
import type { Checker } from './checker';
import { checkConstPattern, pathPattern, patternBindingRes } from './checkerConstPatterns';
import { resolveStructPath, resolveValuePath } from './checkerPaths';
import { checkFieldVisible, isPlaceExpr, requireMutablePlace } from './checkerPlaces';
import { normalize } from './infer';
import { compileError } from './items';
import { checkRangeOrder } from './rangePatterns';
import { adt, freshVar, ref, resolve, shallow, substitute, type Type, typeToString } from './types';

export function checkPattern(c: Checker, pattern: Pattern, type: Type, mode: LocalVar['mode']): void {
  checkPatternPart(c, pattern, type, mode);
  distinctBindings(c, pattern);
}

/** Requires the value a pattern matches to be mutable where a `ref mut` binding borrows it mutably. */
export function requireRefMutSource(c: Checker, pattern: Pattern, source: Expr): void {
  if (bindsRefMutDirectly(pattern) && isPlaceExpr(c, source)) requireMutablePlace(c, source, 'ref mut で借りる');
}

function bindsRefMutDirectly(pattern: Pattern): boolean {
  const t = pattern.ty && normalize(shallow(pattern.ty));
  if (t?.kind === 'ref' && pattern.kind !== 'binding') return false;
  switch (pattern.kind) {
    case 'binding': {
      return pattern.byRef === 'refMut' || (pattern.sub !== undefined && bindsRefMutDirectly(pattern.sub));
    }
    case 'tuple':
    case 'tupleStruct':
    case 'slice': {
      return pattern.elems.some(bindsRefMutDirectly);
    }
    case 'struct': {
      return pattern.fields.some((field) => bindsRefMutDirectly(field.pattern));
    }
    case 'or': {
      return pattern.alternatives.some(bindsRefMutDirectly);
    }
    default: {
      return false;
    }
  }
}

/** Checks the patterns of one parameter list, which must not bind a name twice between them either (E0415). */
export function checkParamPatterns(c: Checker, patterns: Pattern[], types: Type[]): void {
  const names = new Set<string>();
  for (const [index, pattern] of patterns.entries()) {
    checkPattern(c, pattern, types[index], 'move');
    for (const name of distinctBindings(c, pattern)) {
      if (names.has(name)) compileError(pattern.span, `引数の並びで ${name} が2回束縛されています。`);
      names.add(name);
    }
    c.requireIrrefutable(pattern, types[index], 'fn');
  }
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
    case 'slice':
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
 * Matching a reference with a pattern that is not a reference pattern looks through it and binds by reference, as
 * Rust's match ergonomics do. `inherited`: the outer reference of `type` is the one a default binding mode gives the
 * field (`ref`).
 */
// code-gauge-allow functionNcss -- One case per kind of pattern.
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
    case 'range': {
      rangePattern(c, pattern, type, t);
      return;
    }
    case 'slice': {
      slicePattern(c, pattern, type, t, mode);
      return;
    }
    case 'rest': {
      compileError(pattern.span, '.. は、タプル・タプル構造体・スライスのパターンの中にだけ書けます。');
    }
  }
}

/** Replaces the `..` among the element patterns with as many `_` as the elements it stands for. */
function expandRest(elems: Pattern[], count: number, span: Span): Pattern[] {
  const rest = elems.findIndex((elem) => elem.kind === 'rest');
  if (rest === -1) return elems;
  if (elems.findLastIndex((elem) => elem.kind === 'rest') !== rest) {
    compileError(span, '.. は、パターンの中に1回だけ書けます。');
  }
  const fill = Math.max(0, count - (elems.length - 1));
  const wilds = Array.from({ length: fill }, (): Pattern => ({ kind: 'wild', span: elems[rest].span }));
  return [...elems.slice(0, rest), ...wilds, ...elems.slice(rest + 1)];
}

function rangePattern(c: Checker, pattern: Extract<Pattern, { kind: 'range' }>, type: Type, outer: Type): void {
  const { t } = derefForMatch(outer, 'move');
  for (const end of [pattern.start, pattern.end]) {
    if (!end) continue;
    checkPatternPart(c, end, t, 'move');
    const endType = normalize(shallow(t));
    if (endType.kind !== 'int' && endType.kind !== 'char' && endType.kind !== 'float' && endType.kind !== 'var') {
      compileError(
        pattern.span,
        `範囲のパターンは、整数・小数・文字にだけ使えます（${typeToString(resolve(type))} には使えません）。`
      );
    }
  }
  if (!pattern.inclusive && !pattern.end && pattern.start === undefined) {
    compileError(pattern.span, '範囲のパターンの書き方に誤りがあります。');
  }
  checkRangeOrder(c, pattern);
}

// code-gauge-allow functionCognitiveComplexity -- Follows rustc checks for slice and array patterns with a rest element.
function slicePattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'slice' }>,
  type: Type,
  outer: Type,
  mode: LocalVar['mode']
): void {
  let { t, bindingMode } = derefForMatch(outer, mode);
  const restIndex = pattern.elems.findIndex(isRestElement);
  if (pattern.elems.findLastIndex(isRestElement) !== restIndex) {
    compileError(pattern.span, '.. は、スライスのパターンの中に1回だけ書けます。');
  }
  pattern.restIndex = restIndex === -1 ? undefined : restIndex;
  const fixed = pattern.elems.length - (restIndex === -1 ? 0 : 1);
  if (t.kind === 'var') {
    if (restIndex !== -1) compileError(pattern.span, 'スライスのパターンが合う値の型が決まりません。');
    c.unifier.unify(t, { kind: 'array', elem: freshVar(), len: fixed });
    t = normalize(shallow(t));
  }
  if (t.kind !== 'array' && t.kind !== 'slice') {
    compileError(
      pattern.span,
      `パターンの型が合いません（${typeToString(resolve(type))} にスライスのパターンは合いません）。`
    );
  }
  if (t.kind === 'array' && (restIndex === -1 ? fixed !== t.len : fixed > t.len)) {
    compileError(
      pattern.span,
      `パターンの要素の数が合いません（配列の要素は ${t.len} 個ですが、パターンは ${fixed} 個${restIndex === -1 ? '' : '以上'}です）。`
    );
  }
  const elemType = (inner: Type): Type => (bindingMode === 'move' ? inner : ref(inner, bindingMode === 'refMut'));
  const subMode = bindingMode === 'move' ? mode : 'move';
  for (const [index, elem] of pattern.elems.entries()) {
    if (index !== restIndex) {
      checkPatternPart(c, elem, elemType(t.elem), subMode, bindingMode !== 'move');
      continue;
    }
    if (elem.kind === 'rest') {
      elem.ty = t;
      continue;
    }
    // `rest @ ..` binds the elements `..` stands for: an array of them, or a slice.
    const restType: Type = t.kind === 'array' ? { kind: 'array', elem: t.elem, len: t.len - fixed } : t;
    // An unsized slice is bound only by reference: through a reference, or with `ref rest @ ..`.
    const byRef = elem.kind === 'binding' && elem.byRef !== undefined;
    if (t.kind === 'slice' && bindingMode === 'move' && !byRef) {
      compileError(
        elem.span,
        `${(elem as { name: string }).name} @ .. は、スライスの参照に合わせたときにだけ書けます。`
      );
    }
    checkPatternPart(c, elem, elemType(restType), subMode, bindingMode !== 'move');
  }
}

function isRestElement(pattern: Pattern): boolean {
  return pattern.kind === 'rest' || (pattern.kind === 'binding' && pattern.sub?.kind === 'rest');
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

// code-gauge-allow functionCognitiveComplexity -- Binding modes, ref and mut follow rustc rules case by case.
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
  if (inherited) inheritedBinding(pattern, t);
  else checkVariantBinding(pattern, matched, mode);
  const byRef = pattern.byRef && ref(type, pattern.byRef === 'refMut');
  const localType = byRef ?? (mode === 'move' ? type : ref(t, mode === 'refMut'));
  const existing = c.orBindings?.get(pattern.name);
  if (existing) {
    if (existing.mode !== mode || existing.mutable !== pattern.mutable) {
      compileError(pattern.span, `| の各パターンで、${pattern.name} を同じ方法で束縛してください。`);
    }
    c.unifyOrError(pattern.span, existing.type, localType);
    c.annotations.bindings.set(pattern, existing);
    (c.body.scopes.at(-1) as Map<string, LocalVar>).set(pattern.name, existing);
    if (pattern.sub && pattern.sub.kind !== 'rest') checkPatternPart(c, pattern.sub, type, mode);
    return;
  }
  const local = c.declareLocal(pattern.name, localType, pattern.mutable, pattern.span, mode);
  if (pattern.mutable && mode !== 'move') {
    compileError(pattern.span, '参照に合わせたパターンの名前には、mut を付けられません。');
  }
  c.annotations.bindings.set(pattern, local);
  if (pattern.sub && pattern.sub.kind !== 'rest') checkPatternPart(c, pattern.sub, type, mode);
}

/** A binding a default binding mode borrows for: one `mut` or `ref` may not modify in edition 2024. */
function inheritedBinding(pattern: Extract<Pattern, { kind: 'binding' }>, t: Type): void {
  if (pattern.mutable || pattern.byRef) {
    const written = pattern.byRef === 'refMut' ? 'ref mut' : pattern.byRef ? 'ref' : 'mut';
    compileError(
      pattern.span,
      `参照を分解するパターンの中では、${written} ${pattern.name} と書けません（パターンに & を書くか、値を分解してください）。`
    );
  }
  if (t.kind === 'ref') pattern.inheritedRef = t.mutable ? 'refMut' : 'ref';
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
  // A byte string (`b"ab"`, a `&[u8; 2]`) is a reference, which matches a `&[u8; 2]` or a `&[u8]` as it is.
  if (pattern.expr.kind === 'ref') {
    byteStringPattern(c, pattern, type);
    return;
  }
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

function byteStringPattern(c: Checker, pattern: Extract<Pattern, { kind: 'lit' }>, type: Type): void {
  const bytes = c.expr(pattern.expr, undefined);
  const t = normalize(shallow(type));
  const target = t.kind === 'ref' ? normalize(shallow(t.target)) : undefined;
  if (target?.kind === 'slice') c.unifyOrError(pattern.span, target.elem, { kind: 'int', name: 'u8' });
  else c.unifyOrError(pattern.span, type, bytes);
}

function tuplePattern(
  c: Checker,
  pattern: Extract<Pattern, { kind: 'tuple' }>,
  type: Type,
  outer: Type,
  mode: LocalVar['mode']
): void {
  let { t, bindingMode } = derefForMatch(outer, mode);
  if (pattern.elems.some((elem) => elem.kind === 'rest')) {
    if (t.kind !== 'tuple') compileError(pattern.span, '.. を含むタプルのパターンが合う値の型が決まりません。');
    pattern.elems = expandRest(pattern.elems, t.elems.length, pattern.span);
  }
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

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
// code-gauge-allow functionNcss -- Follows the type checking rules of rustc case by case.
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
    pathPattern(c, pattern, res, t);
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
    pattern.elems = expandRest(pattern.elems, variant.fields.length, pattern.span);
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
  if (missing.length > 0 && !pattern.rest) {
    compileError(pattern.span, `パターンにフィールド ${missing.map((f) => f.name).join(', ')} が足りません。`);
  }
}
