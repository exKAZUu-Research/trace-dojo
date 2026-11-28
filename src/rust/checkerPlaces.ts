import type { LocalVar } from './annotations';
import { projectionOf } from './assocTypes';
import type { Expr, Span } from './ast';
import type { Checker } from './checker';
import { collectionKeyTraits } from './collectionBounds';
import { normalize } from './infer';
import { compileError, visibleFrom } from './items';
import { autoderefSteps, derefOnce, lookupMethod } from './methods';
import { RANGE_TYPES } from './traits';
import {
  type AdtDef,
  allSupertraits,
  type DerefKind,
  type FieldDef,
  freshVar,
  ref,
  resolve,
  sameType,
  shallow,
  STR,
  substitute,
  type Type,
  typeToString,
  UNIT,
  USIZE,
} from './types';

/** Requires a place to be mutable: rooted in a `mut` variable or behind a `&mut` reference. */
export function requireMutablePlace(c: Checker, place: Expr, purpose: string, derefs: readonly DerefKind[] = []): void {
  const root = throughDerefs(c, place, derefs);
  if (root.kind === 'temporary') return;
  if (root.kind === 'sharedRef') {
    compileError(place.span, `& の参照の先は書き換えられません（${purpose}には &mut の参照が要ります）。`);
  }
  if (root.kind === 'mutRef') return;
  const { local } = root;
  if (local.mutable) return;
  if (local.mode === 'refMut') return;
  if (local.mode === 'ref') {
    compileError(place.span, `${local.name} は参照なので、書き換えられません。`);
  }
  const isWhole = place.kind === 'path';
  if (isWhole && purpose === '代入する') {
    // Assigning a variable declared without an initializer is its initialization, which the borrow checker checks.
    return;
  }
  compileError(
    place.span,
    `変数 ${local.name} は mut ではないので、${isWhole ? '書き換えられません' : '中身を書き換えられません'}（let mut ${local.name} と宣言してください）。`
  );
}

type PlaceRoot =
  | { kind: 'local'; local: LocalVar }
  | { kind: 'mutRef' }
  | { kind: 'sharedRef' }
  | { kind: 'temporary' };

/** What a place expression is rooted in, looking through fields, indexes, and derefs. */
// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
function placeRoot(c: Checker, place: Expr): PlaceRoot {
  switch (place.kind) {
    case 'path': {
      const res = c.annotations.paths.get(place);
      if (res?.kind === 'local' || res?.kind === 'capture') return { kind: 'local', local: res.local };
      if (res?.kind === 'const' && res.def.ast.isStatic)
        return res.def.ast.isMutable ? { kind: 'mutRef' } : { kind: 'sharedRef' };
      return { kind: 'temporary' };
    }
    case 'field': {
      const field = c.annotations.fields.get(place);
      return throughDerefs(c, place.operand, field?.derefs ?? []);
    }
    case 'index': {
      const index = c.annotations.indexes.get(place);
      if (index?.container === 'map') return { kind: 'sharedRef' };
      if (index?.implTypes) {
        const [self, indexType] = index.implTypes;
        c.require(self, { trait: c.program.traitDef('IndexMut'), args: [indexType] }, place.span);
      }
      return throughDerefs(c, place.operand, index?.derefs ?? []);
    }
    case 'unary': {
      return place.op === '*' ? derefRoot(c, place.operand) : { kind: 'temporary' };
    }
    case 'methodCall': {
      const type = normalize(shallow(place.ty ?? UNIT));
      if (type.kind === 'ref') return type.mutable ? { kind: 'mutRef' } : { kind: 'sharedRef' };
      return { kind: 'temporary' };
    }
    default: {
      return { kind: 'temporary' };
    }
  }
}

/** The root of `*operand`: what a raw pointer points to, or what the reference or owner derefs to. */
function derefRoot(c: Checker, operand: Expr): PlaceRoot {
  const type = normalize(shallow(operand.ty ?? UNIT));
  if (type.kind === 'adt' && type.def.builtin === 'MutPtr') return { kind: 'mutRef' };
  if (type.kind === 'adt' && type.def.builtin === 'ConstPtr') return { kind: 'sharedRef' };
  const deref = type.kind === 'ref' ? (type.mutable ? 'mutRef' : 'ref') : (derefOnce(c.program, type)?.kind ?? 'own');
  return throughDerefs(c, operand, [deref]);
}

function throughDerefs(c: Checker, operand: Expr, derefs: readonly DerefKind[]): PlaceRoot {
  if (derefs.includes('ref')) return { kind: 'sharedRef' };
  let type = operand.ty ?? UNIT;
  for (const step of derefs) {
    // The program's `Deref` gives a place to write to only through its `DerefMut`.
    if (step === 'user' && c.solver.implements(type, { trait: c.program.traitDef('DerefMut'), args: [] }) === 'no') {
      return { kind: 'sharedRef' };
    }
    type = derefOnce(c.program, type)?.type ?? type;
  }
  const base = placeRoot(c, operand);
  return base.kind !== 'sharedRef' && derefs.includes('mutRef') ? { kind: 'mutRef' } : base;
}

export function isPlaceExpr(c: Checker, expr: Expr): boolean {
  if (expr.kind === 'path') {
    const res = c.annotations.paths.get(expr);
    if (res?.kind === 'const' && res.def.ast.isStatic) return true;
    return res?.kind === 'local' || res?.kind === 'capture' || res?.kind === 'discard';
  }
  if (expr.kind === 'field' || expr.kind === 'index') return true;
  return expr.kind === 'unary' && expr.op === '*';
}

/** Whether this field is the one an assignment writes, which only it is: the place the field is in is read. */
function takeUnionWrite(c: Checker): boolean {
  const writing = c.body.writingUnionField === true;
  c.body.writingUnionField = false;
  return writing;
}

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
export function checkField(c: Checker, expr: Extract<Expr, { kind: 'field' }>): Type {
  const writing = takeUnionWrite(c);
  const operandType = fieldOperandType(c, expr, writing);
  for (const step of autoderefSteps(c.program, operandType)) {
    const t = normalize(shallow(step.type));
    if (t.kind === 'var')
      compileError(expr.span, `型が決まらないので、フィールド ${expr.name} を読めません（変数の型を書いてください）。`);
    if (t.kind === 'tuple' && /^\d+$/.test(expr.name)) {
      const index = Number(expr.name);
      if (index >= t.elems.length) compileError(expr.nameSpan, `タプルに ${index} 番目の要素はありません。`);
      c.annotations.fields.set(expr, { derefs: step.derefs, index, range: false });
      return t.elems[index];
    }
    if (t.kind === 'adt' && t.def.kind === 'struct') {
      const variant = t.def.variants[0];
      const index = variant?.fields.findIndex((field) => field.name === expr.name) ?? -1;
      if (index < 0) continue;
      const field = variant.fields[index];
      checkFieldVisible(c, t.def, field, expr.nameSpan);
      if (t.def.isUnion && !writing) c.requireUnsafe(expr.span, '共用体のフィールドを読むこと');
      const subst = new Map(t.def.params.map((param, i) => [param, t.args[i]]));
      c.annotations.fields.set(expr, {
        derefs: step.derefs,
        index,
        range: RANGE_TYPES.has(t.def.builtin as string),
      });
      return substitute(field.type, subst);
    }
  }
  const t = typeToString(resolve(operandType));
  const method = lookupMethod(c.program, c.solver, operandType, expr.name);
  if (method && method !== 'ambiguous') {
    compileError(expr.nameSpan, `${expr.name} はメソッドなので、${expr.name}() と書いてください。`);
  }
  return compileError(expr.nameSpan, `${t} にフィールド ${expr.name} がありません。`);
}

/** The type of a field's operand; a write to a field of a union's field (`u.p.x = 3`) writes into it, unread. */
function fieldOperandType(c: Checker, expr: Extract<Expr, { kind: 'field' }>, writing: boolean): Type {
  c.body.writingUnionField = writing && expr.operand.kind === 'field';
  try {
    return c.settled(c.expr(expr.operand, undefined));
  } finally {
    c.body.writingUnionField = false;
  }
}

export function checkFieldVisible(c: Checker, def: AdtDef, field: FieldDef, span: Span): void {
  if (!visibleFrom(field.visibleWithin, c.body.module)) {
    compileError(span, `${def.name} のフィールド ${field.name} は非公開です。`);
  }
}

export function checkIndex(c: Checker, expr: Extract<Expr, { kind: 'index' }>): Type {
  const operandType = c.settled(c.expr(expr.operand, undefined));
  let previous: Type | undefined;
  for (const step of autoderefSteps(c.program, operandType)) {
    const t = normalize(shallow(step.type));
    const overloaded =
      previous?.kind === 'adt' && (previous.def.builtin === 'Vec' || previous.def.builtin === 'String');
    previous = t;
    if (t.kind === 'var')
      compileError(expr.span, '型が決まらないので、[ ] で要素を取り出せません（変数の型を書いてください）。');
    if (t.kind === 'adt' && (t.def.builtin === 'HashMap' || t.def.builtin === 'BTreeMap')) {
      return indexMap(c, expr, t.def.builtin, t.args, step);
    }
    const isDeque = t.kind === 'adt' && t.def.builtin === 'VecDeque';
    if (t.kind === 'slice' || t.kind === 'array' || t.kind === 'str' || isDeque) {
      return indexSequence(c, expr, t, step, overloaded);
    }
    const user = userIndex(c, expr, t, step);
    if (user) return user;
  }
  return compileError(expr.span, `${typeToString(resolve(operandType))} は [ ] で要素を取り出せません。`);
}

type DerefStep = ReturnType<typeof autoderefSteps>[number];

/** `x[i]` on a type with an `Index` impl of the program, or a type parameter bounded by `Index`. */
function userIndex(c: Checker, expr: Extract<Expr, { kind: 'index' }>, t: Type, step: DerefStep): Type | undefined {
  if (t.kind !== 'param' && !(t.kind === 'adt' && !t.def.builtin)) return undefined;
  const trait = c.program.traitDef('Index');
  const indexType = c.expr(expr.index, undefined);
  // A parameter's bounds, with their supertraits (`IndexMut<usize>` brings `Index<usize>`), may name one index type.
  if (t.kind === 'param') {
    const indexes = allSupertraits(t.param.bounds, t).filter((bound) => bound.trait === trait);
    const [first] = indexes;
    if (first && indexes.every((bound) => sameType(bound.args[0], first.args[0])))
      c.unifier.tryUnify(indexType, first.args[0]);
  }
  const ref = { trait, args: [indexType] };
  if (c.solver.implements(t, ref) === 'no') return undefined;
  c.require(t, ref, expr.span);
  c.annotations.indexes.set(expr, {
    container: 'user',
    range: false,
    derefs: step.derefs,
    overloaded: true,
    implTypes: [t, indexType],
  });
  return projectionOf(trait, 'Output', t, [indexType]);
}

function indexMap(
  c: Checker,
  expr: Extract<Expr, { kind: 'index' }>,
  map: 'HashMap' | 'BTreeMap',
  [keyType, valueType]: Type[],
  step: DerefStep
): Type {
  const indexType = c.expr(expr.index, ref(keyType));
  // A key whose type is not known yet is a reference whose target the `Borrow` bound settles later.
  if (normalize(shallow(indexType)).kind === 'var') c.unifier.tryUnify(indexType, ref(freshVar()));
  const it = normalize(shallow(indexType));
  if (it.kind !== 'ref') compileError(expr.index.span, `HashMap の [ ] には、キーの参照（&key）を書いてください。`);
  c.require(keyType, { trait: c.program.traitDef('Borrow'), args: [it.target] }, expr.index.span);
  // `Index` asks of the map's key and of the key looked up what the map's own lookups do.
  for (const bound of collectionKeyTraits(map)) {
    c.requireTrait(keyType, bound, expr.span);
    c.requireTrait(it.target, bound, expr.index.span);
  }
  c.annotations.indexes.set(expr, {
    container: 'map',
    range: false,
    derefs: step.derefs,
    overloaded: true,
  });
  return valueType;
}

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
function indexSequence(
  c: Checker,
  expr: Extract<Expr, { kind: 'index' }>,
  t: Type,
  step: DerefStep,
  overloaded: boolean
): Type {
  const isStr = t.kind === 'str';
  const isDeque = t.kind === 'adt' && t.def.builtin === 'VecDeque';
  const indexType = c.expr(expr.index, USIZE);
  const it = normalize(shallow(indexType));
  if (it.kind === 'adt' && RANGE_TYPES.has(it.def.builtin as string)) {
    if (it.args[0]) c.unifyOrError(expr.index.span, USIZE, it.args[0]);
    c.annotations.indexes.set(expr, {
      container: isStr ? 'str' : 'slice',
      range: true,
      derefs: step.derefs,
      overloaded,
    });
    if (isDeque) compileError(expr.span, 'VecDeque は範囲で切り出せません。');
    return isStr ? STR : { kind: 'slice', elem: (t as { elem: Type }).elem };
  }
  if (isStr) {
    compileError(
      expr.span,
      '文字列は [i] で1文字を取り出せません（s.chars().nth(i) か、s.as_bytes()[i] を使ってください）。'
    );
  }
  if (!c.unifier.tryUnify(indexType, USIZE)) {
    compileError(
      expr.index.span,
      `添字は usize にしてください（${typeToString(resolve(indexType))} です。as usize で変換できます）。`
    );
  }
  c.annotations.indexes.set(expr, {
    container: isDeque ? 'vecDeque' : 'slice',
    range: false,
    derefs: step.derefs,
    overloaded: overloaded || isDeque,
  });
  if (isDeque) return (t as { args: Type[] }).args[0];
  return (t as { elem: Type }).elem;
}
