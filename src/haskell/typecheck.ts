import { assert } from 'es-toolkit';

import { EQUALITY_CLASS, FUNCTION_TYPE } from './builtinTypes';
import { type ClassEnv, superPred } from './classEnv';
import { deriveInstance, FUNCTOR_LIKE_CLASSES } from './deriving';
import { type ClassEntity, type Evidence, type InstanceInfo, nextId, type ValueEntity } from './entities';
import { compileError, unsupportedError } from './errors';
import { type Builtins, Checker, newDictParam, typeParamKinds, typeVarNames } from './infer';
import { inferKinds } from './kindCheck';
import { TypePrinter } from './prettyType';
import type { RBinding, RExpr, RType } from './rast';
import type { RClassDecl, RDataDecl, RInstanceDecl, RModule } from './rename';
import type { DerivingStrategy, Span } from './syntax';
import {
  defaultKind,
  freshKindVar,
  freshSkolem,
  instantiateType,
  type Kind,
  mapType,
  matchType,
  type Pred,
  prune,
  quantifyType,
  type Scheme,
  splitApp,
  STAR,
  tap,
  tcon,
  type Type,
  unifyKinds,
  zonk,
} from './types';
import { chargeTypeWork } from './typeWorkBudget';

export interface CheckedInstance {
  info: InstanceInfo;

  bindings: RBinding[];
  sourceDefined: boolean;
}

export interface TypecheckResult {
  instances: CheckedInstance[];

  defaults: RBinding[];
  main?: { entity: ValueEntity; evidence: Evidence[] };
}

export interface TypecheckOptions {
  env: ClassEnv;
  builtins: Builtins;

  isProgram: boolean;

  derivingSupport: (name: string) => ValueEntity;
}

export function typecheckModule(module: RModule, options: TypecheckOptions): TypecheckResult {
  const checker = new Checker(options.env, options.builtins);
  // The library declares functions such as getField whose callers choose a variable by a type application.
  checker.allowAmbiguousTypes = !options.isProgram || module.extensions.has('AllowAmbiguousTypes');
  checker.polyKinds = module.extensions.has('PolyKinds');
  inferKinds(checker, module);
  applyDefaultDecls(checker, module);
  for (const decl of module.dataDecls) defineConstructors(decl);
  for (const decl of module.classes) defineClassMethods(decl, module.extensions.has('UndecidableSuperClasses'));
  const instanceDecls = module.instances.map((decl) =>
    declareInstance(checker, decl, module.name, module.extensions.has('UndecidableInstances'))
  );
  const derived = [
    ...deriveInstances(checker, module, options),
    ...deriveStandaloneInstances(checker, module, options),
  ];
  const instances: CheckedInstance[] = [];
  for (const declared of [...instanceDecls, ...derived]) {
    checkInstanceSupers(checker, declared.info, declared.span);
  }
  checker.inferBindGroup(module.values);
  for (const declared of [...instanceDecls, ...derived])
    instances.push({ ...checkInstanceMethods(checker, declared), sourceDefined: instanceDecls.includes(declared) });
  const defaults = module.classes.flatMap((decl) => checkDefaults(checker, decl));
  const main = options.isProgram ? checkMain(checker, module, options.builtins) : undefined;
  const hole = checker.holes[0];
  if (hole) {
    throw compileError(
      hole.hole.span,
      `型の穴 ${hole.hole.name} があります。ここには ${new TypePrinter().show(hole.type)} 型の式を書いてください。`
    );
  }
  checker.solveTop();
  return { instances, defaults, main };
}

function applyDefaultDecls(checker: Checker, module: RModule): void {
  checker.extendedDefaults = module.extensions.has('ExtendedDefaultRules');
  for (const decl of module.defaultDecls) {
    const types = decl.types.map((type) => {
      const converted = checker.convertType(type, new Map(), new Map(), decl.cls ? decl.cls.tyvarKind : STAR);
      checker.checkKinds();
      return converted;
    });
    if (decl.cls) checker.namedDefaults.set(decl.cls, types);
    else checker.defaultTypes = types;
  }
}

function defineConstructors(decl: RDataDecl): void {
  for (const field of decl.entity.fields.values()) {
    const types = [...field.positions.entries()].map(([con, position]) => con.fieldTypes[position]);
    const first = types[0];
    for (const other of types.slice(1)) {
      const bindings: (Type | undefined)[] = [];
      if (
        !matchType(first, other, bindings) ||
        bindings.some((bound, index) => bound && !(bound.tag === 'tgen' && bound.index === index))
      ) {
        throw compileError(decl.span, `フィールド ${field.name} の型が、構成子ごとに違います。`);
      }
    }
    field.fieldType = first;
    const { kinds, head: recordType } = declHead(decl);
    field.entity.scheme = { kinds, preds: [], type: tap(tcon(FUNCTION_TYPE), recordType, first) };
  }
}

function defineClassMethods(decl: RClassDecl, undecidable: boolean): void {
  for (const sup of decl.entity.supers) {
    if (!undecidable && reachesSuperclass(sup, decl.entity)) {
      throw compileError(decl.span, `クラス ${decl.entity.name} のスーパークラスが循環しています。`);
    }
  }
}

function reachesSuperclass(cls: ClassEntity, target: ClassEntity): boolean {
  const pending = [cls];
  const visited = new Set<ClassEntity>();
  while (pending.length > 0) {
    const current = pending.pop() as ClassEntity;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...current.supers);
  }
  return false;
}

interface DeclaredInstance {
  info: InstanceInfo;
  typeNames: string[];
  bindings: RBinding[];
  span: Span;
}

function declareInstance(
  checker: Checker,
  decl: RInstanceDecl,
  moduleName: string,
  undecidable: boolean
): DeclaredInstance {
  const names = typeVarNames([decl.type]);
  const kinds: Kind[] = names.map(() => freshKindVar());
  const vars = new Map<string, Type>(names.map((name, index) => [name, { tag: 'tgen', index }]));
  const varKinds = new Map<string, Kind>(names.map((name, index) => [name, kinds[index]]));
  const head = checker.convertType(decl.type, vars, varKinds, checker.classKind(decl.cls, decl.span));
  const context = checker.convertConstraints(decl.context, vars, varKinds);
  if (splitApp(head).head.tag !== 'tcon') {
    throw unsupportedError(decl.span, '型変数だけを型に書いたインスタンス');
  }
  checker.checkKinds();
  const info = makeInstance(decl.cls, kinds.map(defaultKind), head, context, moduleName, decl.span);
  if (!undecidable) validateInstanceTermination(info, decl.span);
  registerInstance(checker, info, decl.span);
  return { info, typeNames: names, bindings: decl.bindings, span: decl.span };
}

function validateInstanceTermination(info: InstanceInfo, span: Span): void {
  const headVars = new Map<number, number>();
  const headSize = instanceTypeSize(info.head, headVars);
  for (const pred of info.context) {
    if (pred.cls === EQUALITY_CLASS) continue;
    const vars = new Map<number, number>();
    const size = instanceTypeSize(pred.type, vars);
    if (size >= headSize || [...vars].some(([index, count]) => count > (headVars.get(index) ?? 0))) {
      throw compileError(span, 'インスタンスの文脈は、定義する型より小さくなければなりません。');
    }
  }
}

function instanceTypeSize(type: Type, vars: Map<number, number>): number {
  chargeTypeWork();
  const current = prune(type);
  if (current.tag === 'tgen') vars.set(current.index, (vars.get(current.index) ?? 0) + 1);
  if (current.tag === 'tap') return instanceTypeSize(current.fn, vars) + instanceTypeSize(current.arg, vars);
  return 1;
}

function checkInstanceSupers(checker: Checker, info: InstanceInfo, span: Span): void {
  const skolems = info.kinds.map((kind, index) => freshSkolem(kind, checker.level + 1, `t${index}`));
  const head = instantiateType(info.head, skolems);
  info.contextParams = info.context.map((pred) =>
    newDictParam({ cls: pred.cls, type: instantiateType(pred.type, skolems) })
  );
  const givens = info.contextParams.map((param) => ({
    pred: param.pred,
    evidence: { kind: 'param', param } as Evidence,
  }));
  info.supers = info.cls.supers.map((sup, index) => {
    let evidence: Evidence | undefined;
    checker.checkAgainstScheme(
      { kinds: [], preds: [], type: head },
      () => {
        evidence = checker.want(
          superPred({ cls: info.cls, type: head }, index),
          span,
          `インスタンス ${info.cls.name} のスーパークラス ${sup.name}`
        );
      },
      givens
    );
    return evidence as Evidence;
  });
}

function checkInstanceMethods(checker: Checker, declared: DeclaredInstance): Omit<CheckedInstance, 'sourceDefined'> {
  const { info } = declared;
  const bindings: RBinding[] = [];
  for (const binding of [...declared.bindings, ...genericDefaultBindings(declared)]) {
    if (binding.k !== 'fun' || binding.binder.kind !== 'global') continue;
    const method = binding.binder.entity;
    const index = method.method?.index as number;
    if (info.methods[index]) {
      throw compileError(binding.span, `メソッド ${method.name} が重複して定義されています。`);
    }
    const implementation: ValueEntity = {
      id: nextId(),
      name: method.name,
      module: info.module,
      sort: 'var',
      span: binding.span,
    };
    info.methods[index] = implementation;
    const skolems = info.kinds.map((kind, position) =>
      freshSkolem(kind, checker.level + 1, declared.typeNames[position])
    );
    const head = instantiateType(info.head, skolems);
    const contextParams = info.context.map((pred) =>
      newDictParam({ cls: pred.cls, type: instantiateType(pred.type, skolems) })
    );
    const methodScheme = method.scheme as Scheme;
    const classArgs = info.cls.packed ? splitApp(head).args : [head];
    const rest: Scheme = {
      kinds: methodScheme.kinds.slice(classArgs.length),
      names: methodScheme.names?.slice(classArgs.length),
      preds: methodScheme.preds.slice(1).map((pred) => ({ cls: pred.cls, type: shiftGens(pred.type, classArgs) })),
      type: shiftGens(methodScheme.type, classArgs),
    };
    const givens = contextParams.map((param) => ({ pred: param.pred, evidence: { kind: 'param', param } as Evidence }));
    const scoped = new Map(declared.typeNames.map((name, position) => [name, skolems[position]]));
    const ownParams = checker.withScopedTypes(scoped, () =>
      checker.checkAgainstScheme(rest, (type) => checkClauses(checker, binding, type), givens)
    );
    const implementationBinding: RBinding = {
      ...binding,
      binder: { kind: 'global', entity: implementation },
      dictParams: [...contextParams, ...ownParams],
    };
    bindings.push(implementationBinding);
  }
  return { info, bindings };
}

/**
 * The methods an instance leaves out whose defaults a `default` signature types, defined as those defaults, which
 * the instance's own type then has to satisfy the signature's constraints for.
 */
function genericDefaultBindings(declared: DeclaredInstance): RBinding[] {
  const { cls } = declared.info;
  const defined = new Set(
    declared.bindings.flatMap((binding) =>
      binding.k === 'fun' && binding.binder.kind === 'global' ? [binding.binder.entity] : []
    )
  );
  const span = declared.span;
  return [...(cls.genericDefaults ?? [])].flatMap(([index, generic]) => {
    const method = cls.methods[index];
    if (defined.has(method)) return [];
    const expr: RExpr = { k: 'var', ref: { kind: 'global', entity: generic }, name: method.name, span };
    return [
      {
        k: 'fun',
        binder: { kind: 'global', entity: method },
        clauses: [{ pats: [], rhs: { body: { k: 'plain', expr }, where: { bindings: [] }, span }, span }],
        span,
      } satisfies RBinding,
    ];
  });
}

/** Replaces a method scheme's class parameters with the instance's types, renumbering the method's own variables. */
function shiftGens(type: Type, classArgs: readonly Type[]): Type {
  return mapType(type, (node) =>
    node.tag === 'tgen'
      ? node.index < classArgs.length
        ? classArgs[node.index]
        : { tag: 'tgen', index: node.index - classArgs.length }
      : node
  );
}

function checkDefaults(checker: Checker, decl: RClassDecl): RBinding[] {
  const result: RBinding[] = [];
  for (const binding of decl.defaults) {
    if (binding.k !== 'fun' || binding.binder.kind !== 'global') continue;
    const method = binding.binder.entity;
    const index = method.method?.index as number;
    const generic = decl.entity.genericDefaults?.get(index);
    if (generic) {
      const scheme = generic.scheme as Scheme;
      const params = checker.checkAgainstScheme(scheme, (type, skolems) =>
        checker.withScopedTypes(new Map(decl.params.map((name, index) => [name, skolems[index]])), () =>
          checkClauses(checker, binding, type)
        )
      );
      result.push({ ...binding, binder: { kind: 'global', entity: generic }, dictParams: params });
      continue;
    }
    const implementation: ValueEntity = {
      id: nextId(),
      name: method.name,
      module: decl.entity.module,
      sort: 'var',
      span: binding.span,
    };
    decl.entity.defaults[index] = implementation;
    const params = checker.checkAgainstScheme(method.scheme as Scheme, (type, skolems) =>
      checker.withScopedTypes(new Map(decl.params.map((name, index) => [name, skolems[index]])), () =>
        checkClauses(checker, binding, type)
      )
    );
    const implementationBinding: RBinding = {
      ...binding,
      binder: { kind: 'global', entity: implementation },
      dictParams: params,
    };
    result.push(implementationBinding);
  }
  return result;
}

function checkClauses(checker: Checker, binding: Extract<RBinding, { k: 'fun' }>, type: Type): void {
  binding.type = type;
  for (const clause of binding.clauses) {
    checker.inPatternScope(() => {
      let remaining = type;
      for (const pat of clause.pats) {
        const { param, result } = checker.splitFunction(remaining, clause.span, 'メソッドの引数');
        checker.inferPat(pat, param);
        remaining = result;
      }
      checker.checkRhs(clause.rhs, remaining);
    });
  }
}

// code-gauge-allow functionCognitiveComplexity -- Each branch checks one condition GHC places on a derivable class.
function deriveInstances(checker: Checker, module: RModule, options: TypecheckOptions): DeclaredInstance[] {
  const pending: { decl: RDataDecl; cls: ClassEntity; info: InstanceInfo; span: Span; anyclass: boolean }[] = [];
  for (const decl of module.dataDecls) {
    for (const { cls, span, strategy } of decl.deriving) {
      assert(cls, 'The derived class is unresolved');
      const special = decl.cons.find(({ con }) => con.exKinds)?.con;
      if (special) {
        throw compileError(
          span,
          `構成子 ${special.name} に存在型の型変数・文脈・特定の結果の型があるので、${cls.name} を deriving できません。`
        );
      }
      const anyclass = derivingStrategy(module, options, decl, cls, strategy, span) === 'anyclass';
      const functorLike = !anyclass && FUNCTOR_LIKE_CLASSES.has(cls.name);
      const { kinds, head: fullHead } = declHead(decl);
      const headKinds = functorLike ? kinds.slice(0, -1) : kinds;
      const head = functorLike
        ? tap(tcon(decl.entity), ...headKinds.map((_, index): Type => ({ tag: 'tgen', index })))
        : fullHead;
      const info = makeInstance(cls, headKinds, head, [], module.name, span);
      registerInstance(checker, info, span);
      pending.push({ decl, cls, info, span, anyclass });
    }
  }
  // Infer the contexts together, since derived instances of mutually recursive types depend on each other.
  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const item of pending) {
      if (item.anyclass) continue;
      const context = inferDerivedContext(checker, item.decl, item.cls, item.span);
      if (!sameContext(context, item.info.context)) {
        item.info.context = context;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return pending.map((item) => ({
    info: item.info,
    typeNames: item.decl.params,
    bindings: item.anyclass ? [] : deriveInstance(item.decl, item.cls, options.derivingSupport),
    span: item.span,
  }));
}

/** Instances that `deriving instance` declares, with the contexts they state. */
function deriveStandaloneInstances(checker: Checker, module: RModule, options: TypecheckOptions): DeclaredInstance[] {
  return module.standaloneDerivings.map((standalone) => {
    const { head } = splitRType(standalone.type);
    const decl = head.k === 'con' ? module.dataDecls.find((candidate) => candidate.entity === head.entity) : undefined;
    if (!decl) throw unsupportedError(standalone.span, 'このプログラムで定義していない型の deriving');
    const strategy = derivingStrategy(module, options, decl, standalone.cls, standalone.strategy, standalone.span);
    const declared = declareInstance(
      checker,
      { cls: standalone.cls, type: standalone.type, context: standalone.context, bindings: [], span: standalone.span },
      module.name,
      module.extensions.has('UndecidableInstances')
    );
    declared.bindings = strategy === 'anyclass' ? [] : deriveInstance(decl, standalone.cls, options.derivingSupport);
    return declared;
  });
}

/** How a class is derived for a data type, rejecting a class that cannot be derived as asked. */
function derivingStrategy(
  module: RModule,
  options: TypecheckOptions,
  decl: RDataDecl,
  cls: ClassEntity,
  strategy: DerivingStrategy | undefined,
  span: Span
): 'stock' | 'anyclass' {
  if (strategy === 'anyclass') return 'anyclass';
  const stock = options.builtins.derivableClasses.has(cls);
  if (!stock) {
    if (strategy === undefined && module.extensions.has('DeriveAnyClass')) return 'anyclass';
    if (['Generic', 'Data', 'Lift', 'Typeable'].includes(cls.name))
      throw unsupportedError(span, `${cls.name} の deriving`);
    throw compileError(span, `クラス ${cls.name} は deriving できません。`);
  }
  const extension = { Functor: 'DeriveFunctor', Foldable: 'DeriveFoldable', Traversable: 'DeriveTraversable' }[
    cls.name
  ];
  if (extension && !module.extensions.has(extension)) {
    throw compileError(span, `${cls.name} を deriving するには、${extension} の拡張が要ります。`);
  }
  checkDerivable(decl, cls, span);
  return 'stock';
}

function splitRType(type: RType): { head: RType; args: RType[] } {
  const args: RType[] = [];
  let head = type;
  while (head.k === 'app') {
    args.unshift(head.arg);
    head = head.fn;
  }
  return { head, args };
}

export function makeInstance(
  cls: ClassEntity,
  kinds: Kind[],
  head: Type,
  context: Pred[],
  moduleName: string,
  span?: Span
): InstanceInfo {
  return {
    id: nextId(),
    cls,
    kinds,
    head,
    context,
    equalities: [],
    methods: Array.from<ValueEntity | undefined>({ length: cls.methods.length }),
    supers: [],
    contextParams: [],
    module: moduleName,
    span,
  };
}

function registerInstance(checker: Checker, info: InstanceInfo, span: Span): void {
  for (const existing of checker.env.instancesOf(info.cls)) {
    if (matchType(existing.head, info.head, []) && matchType(info.head, existing.head, [])) {
      const printer = new TypePrinter();
      throw compileError(
        span,
        `${info.cls.name} ${printer.show(
          instantiateType(
            info.head,
            info.kinds.map((_, index) => freshSkolem(STAR, 0, `t${index}`))
          ),
          2
        )} のインスタンスが重複しています。`
      );
    }
  }
  checker.env.add(info);
}

/**
 * The kinds of a data declaration's variables and the type it declares in terms of them: the type applied to its
 * parameters, or for a data instance, the family applied to the instance's types.
 */
function declHead(decl: RDataDecl): { kinds: Kind[]; head: Type } {
  const first = decl.cons[0]?.con;
  if (decl.instanceArgs) {
    const kinds = first?.instanceKinds ?? decl.params.map(() => STAR);
    return { kinds, head: tap(tcon(decl.entity), ...(first?.instanceArgs ?? [])) };
  }
  const kinds = typeParamKinds(decl.entity);
  return { kinds, head: tap(tcon(decl.entity), ...kinds.map((_, index): Type => ({ tag: 'tgen', index }))) };
}

function checkDerivable(decl: RDataDecl, cls: ClassEntity, span: Span): void {
  const cons = decl.cons.map(({ con }) => con);
  if (FUNCTOR_LIKE_CLASSES.has(cls.name)) {
    const kinds = typeParamKinds(decl.entity);
    if (kinds.length === 0 || !unifyKinds(kinds.at(-1) as Kind, STAR)) {
      throw compileError(
        span,
        `${decl.entity.name} は型引数をとる型ではないので、${cls.name} を deriving できません。`
      );
    }
  }
  if (cls.name === 'Enum' && (cons.length === 0 || cons.some((con) => con.arity > 0))) {
    throw compileError(
      span,
      `${decl.entity.name} の Enum は deriving できません（引数のない構成子だけの型にしてください）。`
    );
  }
  if (cls.name === 'Bounded' && (cons.length === 0 || (cons.length > 1 && cons.some((con) => con.arity > 0)))) {
    throw compileError(span, `${decl.entity.name} の Bounded は deriving できません。`);
  }
}

function inferDerivedContext(checker: Checker, decl: RDataDecl, cls: ClassEntity, span: Span): Pred[] {
  const { kinds } = declHead(decl);
  const params = kinds.map((kind, index) => freshSkolem(kind, 1_000_000, decl.params[index] ?? `t${index}`));
  const work: Pred[] = [];
  for (const { con } of decl.cons) {
    for (const field of con.fieldTypes) {
      if (FUNCTOR_LIKE_CLASSES.has(cls.name)) {
        for (const type of functorLikeConstraints(field, kinds.length - 1)) {
          work.push({ cls, type: instantiateType(type, params) });
        }
      } else work.push({ cls, type: instantiateType(field, params) });
    }
  }
  const context: Pred[] = [];
  const printer = new TypePrinter();
  const keys = new Set<string>();
  while (work.length > 0) {
    const pred = work.pop() as Pred;
    const type = zonk(pred.type);
    if (inferableDerivedType(type)) {
      const generic = quantifyType(type, params);
      const key = `${pred.cls.id}:${printer.show(generic)}`;
      if (!keys.has(key)) {
        keys.add(key);
        context.push({ cls: pred.cls, type: generic });
      }
      continue;
    }
    const found = checker.env.findInstance({ cls: pred.cls, type });
    if (typeof found === 'string') {
      throw compileError(
        span,
        `${printer.showPred({ cls: pred.cls, type })} のインスタンスがないので、${cls.name} を deriving できません。`
      );
    }
    for (const contextPred of found.instance.context) {
      work.push({ cls: contextPred.cls, type: instantiateType(contextPred.type, found.args) });
    }
  }
  return context.toSorted((a, b) => printer.showPred(a).localeCompare(printer.showPred(b)));
}

/**
 * The type constructors a functor-like instance of a field needs the class at: `F t1 .. tk-1` for each application
 * `F t1 .. tk` whose last argument uses the type's last parameter.
 */
function functorLikeConstraints(type: Type, last: number): Type[] {
  const mentions = (node: Type): boolean =>
    node.tag === 'tgen' ? node.index === last : node.tag === 'tap' && (mentions(node.fn) || mentions(node.arg));
  const result: Type[] = [];
  const pending = [type];
  while (pending.length > 0) {
    chargeTypeWork();
    const node = pending.pop() as Type;
    if (!mentions(node) || node.tag !== 'tap') continue;
    const { head, args } = splitApp(node);
    if (head.tag === 'tcon' && (head.entity === FUNCTION_TYPE || head.entity.special === 'tuple')) {
      pending.push(...args);
      continue;
    }
    result.push(node.fn);
    pending.push(node.arg);
  }
  return result;
}

function inferableDerivedType(type: Type): boolean {
  const variables = new Set<Type>();
  const pending = [type];
  while (pending.length > 0) {
    chargeTypeWork();
    const node = pending.pop() as Type;
    if (node.tag === 'tap') pending.push(node.fn, node.arg);
    else if (node.tag === 'tvar' && !variables.has(node)) variables.add(node);
    else return false;
  }
  return true;
}

function sameContext(a: Pred[], b: Pred[]): boolean {
  const printer = new TypePrinter();
  return a.length === b.length && a.every((pred, index) => printer.showPred(pred) === printer.showPred(b[index]));
}

function checkMain(
  checker: Checker,
  module: RModule,
  builtins: Builtins
): { entity: ValueEntity; evidence: Evidence[] } {
  const main = module.exports.values.get('main');
  const binding = module.values.bindings.find((candidate) =>
    candidate.k === 'pat'
      ? candidate.globals?.some((entity) => entity.name === 'main')
      : candidate.binder.kind === 'global' && candidate.binder.entity.name === 'main'
  );
  const entity =
    binding?.k === 'pat'
      ? binding.globals?.find((global) => global.name === 'main')
      : binding?.binder.kind === 'global'
        ? binding.binder.entity
        : undefined;
  if (!binding || !entity) {
    throw compileError(0, 'main が定義されていません。');
  }
  if (!main && module.hasExportList && module.name === 'Main') {
    throw compileError(binding.span, 'main が export されていません。');
  }
  const scheme = entity.scheme as Scheme;
  const instantiated = checker.instantiate(scheme, binding.span, 'main');
  checker.unify(
    instantiated.type,
    tap(tcon(builtins.io), checker.freshVar()),
    binding.span,
    'main の型は IO でなければなりません'
  );
  return { entity, evidence: instantiated.evidence };
}
