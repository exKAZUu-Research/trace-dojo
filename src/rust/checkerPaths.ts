import type { PathRes } from './annotations';
import type { Expr, PathAst, Span, TypeAst } from './ast';
import type { Checker } from './checker';
import { selfParamType } from './checkerCalls';
import { checkFieldVisible } from './checkerPlaces';
import { normalize } from './infer';
import {
  compileError,
  globAnonymousTraits,
  globTypeNames,
  lookupAssociatedConst,
  lookupType,
  lookupValue,
  type Module,
  resolveTypePath,
  type TypeBinding,
  type ValueBinding,
} from './items';
import { boundsOf, lookupAssociated } from './methods';
import {
  adt,
  type AdtDef,
  CHAR,
  type FnDef,
  freshVar,
  intType,
  shallow,
  substitute,
  substituteTraitRef,
  type TraitDef,
  type Type,
  type TypeParam,
  typeToString,
} from './types';

export function pathExpr(c: Checker, expr: Extract<Expr, { kind: 'path' }>, expected: Type | undefined): Type {
  const res = resolveValuePath(c, expr.path, expr.span);
  c.annotations.paths.set(expr, res);
  return typeOfRes(c, res, expr.span, expected);
}

export function typeOfRes(c: Checker, res: PathRes, span: Span, expected: Type | undefined): Type {
  switch (res.kind) {
    case 'local':
    case 'capture': {
      return res.local.type;
    }
    case 'fn': {
      const sig = c.instantiate(res.fn, res.typeArgs, span);
      const params = res.fn.selfMode ? [selfParamType(res.fn, sig.subst), ...sig.params] : sig.params;
      return { kind: 'fn', params, ret: sig.ret };
    }
    case 'ctor': {
      const variant = res.def.variants[res.variant];
      const self = adt(res.def, res.typeArgs);
      if (variant.shape === 'unit') {
        if (expected) c.unifier.tryUnify(self, expected);
        return self;
      }
      if (variant.shape === 'named') {
        compileError(
          span,
          `${variant.name} はフィールドに名前のある型なので、${variant.name} { ... } の形で作ってください。`
        );
      }
      const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
      return {
        kind: 'fn',
        params: variant.fields.map((field) => substitute(field.type, subst)),
        ret: self,
      };
    }
    case 'const': {
      return res.type;
    }
    case 'builtinConst': {
      return res.type;
    }
    case 'discard': {
      return compileError(span, '_ は、代入の左辺にだけ書けます。');
    }
  }
}

/** The type arguments for a generic item: those written in the path, or fresh variables. */
export function typeArgsFor(
  c: Checker,
  params: TypeParam[],
  written: TypeAst[] | undefined,
  span: Span,
  what: string
): Type[] {
  if (!written) return params.map(() => freshVar());
  if (written.length !== params.length) {
    compileError(span, `${what} の型引数の数が合いません（${params.length} 個です）。`);
  }
  return written.map((arg) => c.lowerType(arg));
}

export function resolveValuePath(c: Checker, path: PathAst, span: Span): PathRes {
  const segments = path.segments;
  if (segments.length === 1) return singleNameRes(c, segments[0], span);
  // A path whose last segment names a value in a module, a variant of an enum, or an associated item of a type.
  const names = segments.map((segment) => segment.name);
  const last = segments.at(-1)!;
  const owner = resolvePrefix(c, segments.slice(0, -1), span);
  if (owner.kind === 'mod') return moduleValueRes(c, owner.module, names, last, span);
  if (owner.kind === 'trait') {
    const fn = owner.def.methods.get(last.name);
    if (!fn) compileError(span, `トレイト ${owner.def.name} にメソッド ${last.name} がありません。`);
    const typeArgs = fn.params.map(() => freshVar());
    return { kind: 'fn', fn, typeArgs };
  }
  return associatedValueRes(c, normalize(shallow(owner.type)), last, span);
}

function singleNameRes(c: Checker, segment: PathAst['segments'][number], span: Span): PathRes {
  const name = segment.name;
  if (name === '_') return { kind: 'discard' };
  const local = c.findLocal(name);
  if (local) return c.localRes(local);
  if (name === 'self') compileError(span, 'self は、self を引数に取るメソッドの中にだけ書けます。');
  if (name === 'Self') return selfCtor(c, span);
  const binding = lookupValue(c.body.module, name, span);
  if (!binding) {
    if (lookupType(c.body.module, name, span)) {
      compileError(span, `${name} は型の名前で、値ではありません。`);
    }
    compileError(span, `${name} が見つかりません。`);
  }
  return valueBindingRes(c, binding, segment.args, span, name);
}

function moduleValueRes(
  c: Checker,
  module: Module,
  names: string[],
  last: PathAst['segments'][number],
  span: Span
): PathRes {
  const binding = module.values.get(last.name) ?? lookupValueIn(module, last.name, span);
  if (!binding) {
    if (module.isStd) unavailableStd([...module.path.split('::'), last.name], span);
    compileError(span, `${names.join('::')} が見つかりません。`);
  }
  const entry = module.values.get(last.name);
  if (entry && !entry.isPublic && !module.isAncestorOf(c.body.module.namedModule)) {
    compileError(span, `${last.name} は非公開です（pub が付いていません）。`);
  }
  return valueBindingRes(c, 'binding' in binding ? binding.binding : binding, last.args, span, names.join('::'));
}

function associatedValueRes(c: Checker, t: Type, last: PathAst['segments'][number], span: Span): PathRes {
  if (t.kind === 'adt' && t.def.kind === 'enum') {
    const variant = t.def.variants.find((v) => v.name === last.name);
    if (variant) {
      const typeArgs = last.args ? typeArgsFor(c, t.def.params, last.args, span, t.def.name) : t.args;
      return { kind: 'ctor', def: t.def, variant: variant.index, typeArgs };
    }
  }
  const constant = associatedConst(c, t, last.name, span);
  if (constant) return constant;
  const found = lookupAssociated(c.program, c.solver, t, last.name);
  if (!found) {
    if (t.kind === 'adt' && t.def.kind === 'enum') {
      compileError(span, `${t.def.name} に列挙子 ${last.name} がありません。`);
    }
    compileError(span, `${typeToString(t)} に関連関数 ${last.name} がありません。`);
  }
  checkMethodVisible(c, found.fn, span);
  checkTraitInScope(c, found.fn, t, span, `関連関数 ${last.name}`);
  if (last.args) {
    const own = found.fn.params.slice(found.fn.parentParamCount);
    const written = typeArgsFor(c, own, last.args, span, last.name);
    found.typeArgs.splice(found.fn.parentParamCount, own.length, ...written);
  }
  return { kind: 'fn', fn: found.fn, typeArgs: found.typeArgs };
}

function unavailableStd(names: string[], span: Span): never {
  const module = names.find((name) => !['std', 'core', 'alloc'].includes(name));
  if (module === 'io' || module === 'fs') {
    compileError(span, '標準入力・ファイルの入出力は、この採点環境では使えません。');
  }
  if (module === 'thread') compileError(span, 'スレッド（std::thread）は、この採点環境では使えません。');
  if (module === 'env')
    compileError(span, '環境変数とコマンドラインの引数（std::env）は、この採点環境では使えません。');
  return compileError(span, `${names.join('::')} は、この採点環境では使えません。`);
}

/** Whether a trait is in scope in the body: imported, in the prelude, or the trait of the body's impl. */
export function traitInScope(c: Checker, trait: TraitDef): boolean {
  if (trait === c.body.currentTrait) return true;
  const isTrait = (binding: TypeBinding | undefined): boolean => binding?.kind === 'trait' && binding.def === trait;
  const { module } = c.body;
  const span = { row: 0, col: 1 };
  if (isTrait(lookupType(module, trait.name, span))) return true;
  for (let scope: Module | undefined = module; scope; scope = scope.lexicalParent) {
    if (scope.anonymousImports.some((entry) => isTrait(entry.types?.binding))) return true;
    for (const visible of globAnonymousTraits(scope)) if (visible === trait) return true;
    for (const name of [...scope.imports.keys(), ...globTypeNames(scope)]) {
      if (isTrait(lookupType(module, name, span))) return true;
    }
  }
  return false;
}

export function checkMethodVisible(c: Checker, fn: FnDef, span: Span): void {
  const item = fn.ast;
  if (!item || item.vis === 'pub' || fn.trait || fn.impl?.trait) return;
  const module = fn.module as Module;
  if (module.isStd) return;
  if (!module.namedModule.isAncestorOf(c.body.module.namedModule)) {
    compileError(span, `${fn.name} は非公開です（pub が付いていません）。`);
  }
}

/** A method of the program's own trait impl is callable only where the trait is in scope, as rustc requires. */
/**
 * Rejects a function of a trait that is not in scope: the program's traits by their impls, and the standard library's
 * outside the prelude. A bound of a type parameter, a trait object, or an opaque type brings its traits into scope.
 */
export function checkTraitInScope(c: Checker, fn: FnDef, selfType: Type, span: Span, what: string): void {
  const isStd = (fn.trait?.module as Module | undefined)?.isStd;
  const trait = isStd ? fn.trait : fn.impl?.trait?.trait;
  if (!trait || boundsOf(selfType) || traitInScope(c, trait)) return;
  if (!isStd && (trait.module as Module).isStd && (trait.module as Module).path !== 'std::io') return;
  compileError(span, `${what} はトレイト ${trait.name} のものなので、use でトレイトを取り込んでください。`);
}

function associatedConst(c: Checker, t: Type, name: string, span: Span): PathRes | undefined {
  if (t.kind === 'int' && ['MAX', 'MIN', 'BITS'].includes(name)) {
    return {
      kind: 'builtinConst',
      type: name === 'BITS' ? intType('u32') : t,
      name: `${t.name}::${name}`,
    };
  }
  if (
    t.kind === 'float' &&
    ['MAX', 'MIN', 'INFINITY', 'NEG_INFINITY', 'NAN', 'EPSILON', 'MIN_POSITIVE'].includes(name)
  ) {
    return { kind: 'builtinConst', type: t, name: `${t.name}::${name}` };
  }
  if (t.kind === 'char' && name === 'MAX') return { kind: 'builtinConst', type: CHAR, name: 'char::MAX' };
  const found = lookupAssociatedConst(c.solver, c.body.module, t, name, span);
  if (!found) return undefined;
  const { def, subst } = found;
  return {
    kind: 'const',
    def,
    type: substitute(def.type, subst),
    typeArgs: def.impl!.params.map((param) => subst.get(param) ?? { kind: 'param', param }),
  };
}

function selfCtor(c: Checker, span: Span): PathRes {
  const self = c.body.selfType ? shallow(c.body.selfType) : undefined;
  if (self?.kind !== 'adt' || self.def.kind !== 'struct' || self.def.variants[0]?.shape === 'named') {
    compileError(span, 'Self を値として使えるのは、タプル構造体とユニット構造体の impl の中だけです。');
  }
  checkTupleConstructorVisible(c, self.def, span);
  return { kind: 'ctor', def: self.def, variant: 0, typeArgs: self.args };
}

function resolvePrefix(
  c: Checker,
  prefix: PathAst['segments'],
  span: Span
): Exclude<TypeBinding, { kind: 'adt' | 'prim' | 'alias' }> | { kind: 'type'; type: Type } {
  const names = prefix.map((segment) => segment.name);
  const last = prefix.at(-1)!;
  if (names.length === 1 && c.body.typeParams.has(names[0])) {
    return { kind: 'type', type: { kind: 'param', param: c.body.typeParams.get(names[0])! } };
  }
  if (names.length === 1 && names[0] === 'Self') {
    if (!c.body.selfType) compileError(span, 'Self は、impl やトレイトの中にだけ書けます。');
    return { kind: 'type', type: c.body.selfType };
  }
  const binding = resolveTypePath(names, c.body.module, span);
  switch (binding.kind) {
    case 'adt': {
      const args = last.args
        ? typeArgsFor(c, binding.def.params, last.args, span, binding.def.name)
        : binding.def.params.map(() => freshVar());
      return { kind: 'type', type: adt(binding.def, args) };
    }
    case 'prim': {
      return { kind: 'type', type: binding.type };
    }
    case 'alias': {
      return { kind: 'type', type: binding.resolve() };
    }
    case 'mod':
    case 'trait': {
      return binding;
    }
  }
}

function valueBindingRes(
  c: Checker,
  binding: ValueBinding,
  args: TypeAst[] | undefined,
  span: Span,
  name: string
): PathRes {
  switch (binding.kind) {
    case 'fn': {
      const fn = binding.def;
      const own = fn.params.slice(fn.parentParamCount);
      const typeArgs = [
        ...fn.params.slice(0, fn.parentParamCount).map(() => freshVar()),
        ...typeArgsFor(c, own, args, span, name),
      ];
      return { kind: 'fn', fn, typeArgs };
    }
    case 'ctor': {
      checkTupleConstructorVisible(c, binding.def, span);
      return {
        kind: 'ctor',
        def: binding.def,
        variant: binding.variant,
        typeArgs: typeArgsFor(c, binding.def.params, args, span, name),
      };
    }
    case 'const': {
      return { kind: 'const', def: binding.def, type: binding.def.type, typeArgs: [] };
    }
  }
}

function checkTupleConstructorVisible(c: Checker, def: AdtDef, span: Span): void {
  if (def.kind !== 'struct' || def.variants[0]?.shape !== 'tuple') return;
  for (const field of def.variants[0].fields) checkFieldVisible(c, def, field, span);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows the type checking rules of rustc case by case.
// code-gauge-allow functionNcss 33 -- Follows the type checking rules of rustc case by case.
export function structExpr(c: Checker, expr: Extract<Expr, { kind: 'struct' }>, expected: Type | undefined): Type {
  const { def, variant, typeArgs } = resolveStructPath(c, expr.path, expr.span);
  const self = adt(def, typeArgs);
  if (expected) c.unifier.tryUnify(self, expected);
  const subst = new Map(def.params.map((param, index) => [param, typeArgs[index]]));
  const variantDef = def.variants[variant];
  if (variantDef.shape === 'unit' && expr.fields.length > 0) {
    compileError(expr.span, `${variantDef.name} にはフィールドがありません。`);
  }
  const seen = new Set<string>();
  for (const field of expr.fields) {
    const index = variantDef.fields.findIndex((f) => f.name === field.name);
    if (index === -1) compileError(field.span, `${variantDef.name} にフィールド ${field.name} がありません。`);
    if (seen.has(field.name)) compileError(field.span, `フィールド ${field.name} が2回あります。`);
    seen.add(field.name);
    if (def.kind === 'struct') checkFieldVisible(c, def, variantDef.fields[index], field.span);
    c.coerceExpr(field.value, substitute(variantDef.fields[index].type, subst));
  }
  c.annotations.paths.set(expr, { kind: 'ctor', def, variant, typeArgs });
  // A struct's bounds on its type parameters hold for every value of it (`struct Labeled<T: Display>`).
  for (const [index, param] of def.params.entries()) {
    for (const bound of param.bounds) c.require(typeArgs[index], substituteTraitRef(bound, subst), expr.span);
  }
  if (expr.base) {
    if (def.kind === 'enum') compileError(expr.base.span, '列挙子には .. を書けません。');
    for (const field of variantDef.fields) if (!seen.has(field.name)) checkFieldVisible(c, def, field, expr.base.span);
    c.coerceExpr(expr.base, self);
    return self;
  }
  const missing = variantDef.fields.filter((field) => !seen.has(field.name)).map((field) => field.name);
  if (missing.length > 0) {
    compileError(expr.span, `${variantDef.name} のフィールド ${missing.join(', ')} の値が足りません。`);
  }
  return self;
}

interface StructPathRes {
  def: AdtDef;
  variant: number;
  typeArgs: Type[];
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows the type checking rules of rustc case by case.
export function resolveStructPath(c: Checker, path: PathAst, span: Span): StructPathRes {
  const names = path.segments.map((segment) => segment.name);
  const last = path.segments.at(-1)!;
  if (names.length === 1 && names[0] === 'Self') {
    const self = c.body.selfType ? shallow(c.body.selfType) : undefined;
    if (self?.kind !== 'adt') compileError(span, 'Self は、impl やトレイトの中にだけ書けます。');
    return { def: self.def, variant: 0, typeArgs: self.args };
  }
  if (names.length > 1) {
    const variant = enumVariantPath(c, path, span);
    if (variant) return variant;
  }
  const binding =
    names.length === 1 ? lookupType(c.body.module, names[0], span) : resolveTypePath(names, c.body.module, span);
  if (binding?.kind === 'adt' && binding.def.kind === 'struct') {
    return {
      def: binding.def,
      variant: 0,
      typeArgs: typeArgsFor(c, binding.def.params, last.args, span, binding.def.name),
    };
  }
  if (binding?.kind === 'alias') {
    const type = normalize(shallow(binding.resolve()));
    if (type.kind === 'adt') return { def: type.def, variant: 0, typeArgs: type.args };
  }
  const value = names.length === 1 ? lookupValue(c.body.module, names[0], span) : undefined;
  if (value?.kind === 'ctor') {
    return {
      def: value.def,
      variant: value.variant,
      typeArgs: value.def.params.map(() => freshVar()),
    };
  }
  return compileError(span, `構造体 ${names.join('::')} が見つかりません。`);
}

function lookupValueIn(module: Module, name: string, span: Span): ValueBinding | undefined {
  return lookupValue(module, name, span);
}

/** The variant of an enum a path names, or undefined when its prefix names no enum or fails to resolve. */
function enumVariantPath(c: Checker, path: PathAst, span: Span): StructPathRes | undefined {
  const last = path.segments.at(-1)!;
  try {
    const owner = resolvePrefix(c, path.segments.slice(0, -1), span);
    if (owner.kind === 'type') {
      const t = normalize(shallow(owner.type));
      if (t.kind === 'adt' && t.def.kind === 'enum') {
        const variant = t.def.variants.find((v) => v.name === last.name);
        if (!variant) compileError(span, `${t.def.name} に列挙子 ${last.name} がありません。`);
        return { def: t.def, variant: variant.index, typeArgs: t.args };
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || !('diagnostics' in error)) throw error;
  }
  return undefined;
}
