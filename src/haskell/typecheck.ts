import { assert } from 'es-toolkit';

import { COERCIBLE_CLASS, COERCIBLE_TYPES, EQUALITY_CLASS, FUNCTION_TYPE } from './builtinTypes';
import { type ClassEnv, superPred } from './classEnv';
import { deriveInstance, FUNCTOR_LIKE_CLASSES } from './deriving';
import { type ClassEntity, type Evidence, type InstanceInfo, nextId, type ValueEntity } from './entities';
import { compileError, unsupportedError } from './errors';
import type { FeatureGates, FeatureOf } from './features';
import { type Builtins, Checker, typeParamKinds, typeVarNames } from './infer';
import { inferKinds } from './kindCheck';
import { TypePrinter } from './prettyType';
import type { RBinding, RExpr, RType } from './rast';
import type { RClassDecl, RDataDecl, RInstanceDecl, RModule } from './rename';
import { annotateRoles, atLeastAsStrict, inferredRoles } from './roles';
import type { DerivingStrategy, Span } from './syntax';
import {
  defaultKind,
  freshKindVar,
  freshSkolem,
  instantiateType,
  type Kind,
  mapType,
  matchType,
  parameterKinds,
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
  type Visibility,
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
  const features = module.extensions.gates('typecheck');
  checker.allowAmbiguousTypes = !options.isProgram || features.allows('ambiguousTypes');
  checker.polyKinds = features.allows('polyKinds');
  checker.monomorphismRestriction = !options.isProgram || features.allows('monomorphismRestriction');
  checker.defaultOverlap = features.allows('incoherentInstances')
    ? 'INCOHERENT'
    : features.allows('overlappingInstances')
      ? 'OVERLAPS'
      : undefined;
  inferKinds(checker, module);
  applyDefaultDecls(checker, module);
  for (const decl of module.dataDecls) defineConstructors(decl);
  checkRoleAnnotations(module);
  for (const decl of module.classes) defineClassMethods(decl, features.allows('undecidableSuperClasses'));
  const instanceDecls = module.instances.map(
    (decl) => declareInstance(checker, decl, module.name, features.allows('undecidableInstances')).declared
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
  for (const declared of [...instanceDecls, ...derived]) {
    instances.push({
      ...checkInstanceMethods(checker, declared, options.derivingSupport('coerce')),
      sourceDefined: instanceDecls.includes(declared),
    });
  }
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

/** Applies the module's `type role` annotations, which may only make a parameter's role stricter. */
function checkRoleAnnotations(module: RModule): void {
  for (const { entity, roles } of module.roleAnnotations) annotateRoles(entity, roles);
  for (const { entity, roles, span } of module.roleAnnotations) {
    const required = inferredRoles(entity);
    const params = module.dataDecls.find((decl) => decl.entity === entity)?.params ?? [];
    for (const [index, role] of roles.entries()) {
      if (role && !atLeastAsStrict(role, required[index])) {
        throw compileError(
          span,
          `型 ${entity.name} の型変数 ${params[index] ?? index + 1} の役割は、${required[index]} より緩くできません（注釈は ${role} です）。`
        );
      }
    }
  }
}

function applyDefaultDecls(checker: Checker, module: RModule): void {
  checker.extendedDefaults = module.extensions.gates('typecheck').allows('extendedDefaultRules');
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
  // A data family's instances share its field table; each instance defines only the fields of its own constructors.
  const own = new Set(decl.cons.map(({ con }) => con));
  for (const field of decl.entity.fields.values()) {
    if (![...field.positions.keys()].some((con) => own.has(con))) continue;
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
    field.entity.scheme = {
      kinds,
      visibilities: kinds.map((): Visibility => 'inferred'),
      preds: [],
      type: tap(tcon(FUNCTION_TYPE), recordType, first),
    };
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
  /**
   * For an instance that `deriving newtype` or `deriving via` derives, the type whose instance it reuses, with the
   * instance's variables as `TGen` indices: each method is that instance's, coerced.
   */
  rep?: Type;
}

function declareInstance(
  checker: Checker,
  decl: RInstanceDecl,
  moduleName: string,
  undecidable: boolean,
  via?: RType
): { declared: DeclaredInstance; vars: Map<string, Type>; varKinds: Map<string, Kind> } {
  const names = typeVarNames([decl.type]);
  const kinds: Kind[] = names.map(() => freshKindVar());
  const vars = new Map<string, Type>(names.map((name, index) => [name, { tag: 'tgen', index }]));
  const varKinds = new Map<string, Kind>(names.map((name, index) => [name, kinds[index]]));
  const head = checker.convertType(decl.type, vars, varKinds, checker.classKind(decl.cls, decl.span));
  const rep = via && checker.convertType(via, vars, varKinds, checker.classKind(decl.cls, decl.span));
  const context = checker.convertConstraints(decl.context, vars, varKinds);
  checker.checkKinds();
  const info = makeInstance(decl.cls, kinds.map(defaultKind), head, context, moduleName, decl.span);
  if (decl.overlap) info.overlap = decl.overlap;
  if (!undecidable) validateInstanceTermination(info, decl.span);
  registerInstance(checker, info, decl.span);
  return { declared: { info, typeNames: names, bindings: decl.bindings, span: decl.span, rep }, vars, varKinds };
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
  const scheme: Scheme = {
    kinds: info.kinds,
    visibilities: info.kinds.map((): Visibility => 'specified'),
    names: info.kinds.map((_, index) => `t${index}`),
    preds: info.context,
    type: info.head,
  };
  info.contextParams = checker.skolemise(scheme, (head) => {
    info.supers = info.cls.supers.map((sup, index) =>
      checker.want(
        superPred({ cls: info.cls, type: head }, index),
        span,
        `インスタンス ${info.cls.name} のスーパークラス ${sup.name}`
      )
    );
  });
}

function checkInstanceMethods(
  checker: Checker,
  declared: DeclaredInstance,
  coerce: ValueEntity
): Omit<CheckedInstance, 'sourceDefined'> {
  const { info } = declared;
  if (declared.rep) return { info, bindings: coercedMethods(checker, declared, declared.rep, coerce) };
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
    const methodScheme = method.scheme as Scheme;
    const scheme = instanceMethodScheme(
      info,
      declared.typeNames,
      methodScheme,
      info.cls.packed ? splitApp(info.head).args : [info.head]
    );
    const dictParams = checker.skolemise(scheme, (type, skolems) =>
      checker.withScopedTypes(new Map(declared.typeNames.map((name, position) => [name, skolems[position]])), () =>
        checker.checkClauses(binding, type, 'メソッドの引数')
      )
    );
    const implementationBinding: RBinding = {
      ...binding,
      binder: { kind: 'global', entity: implementation },
      dictParams,
    };
    bindings.push(implementationBinding);
  }
  return { info, bindings };
}

/**
 * The methods of an instance that `deriving newtype` or `deriving via` derives: each the method of the instance of
 * the type it reuses, coerced to the instance's own type, as `m = coerce (m :: method type at rep)`.
 */
function coercedMethods(
  checker: Checker,
  declared: DeclaredInstance,
  repTemplate: Type,
  coerce: ValueEntity
): RBinding[] {
  const { info, span } = declared;
  const { cls } = info;
  return cls.methods.map((method, index) => {
    const implementation: ValueEntity = { id: nextId(), name: method.name, module: info.module, sort: 'var', span };
    info.methods[index] = implementation;
    const methodScheme = method.scheme as Scheme;
    if (methodScheme.preds.slice(1).some((pred) => mentionsGen(pred.type, 0))) {
      throw unsupportedError(
        span,
        `クラスの型に制約を付けたメソッド ${method.name} を持つクラスの、coerce による deriving`
      );
    }
    const scheme = instanceMethodScheme(info, declared.typeNames, methodScheme, [info.head]);
    const repScheme = instanceMethodScheme(info, declared.typeNames, methodScheme, [repTemplate]);
    let body: RExpr | undefined;
    let bodyType: Type | undefined;
    const origin = `${cls.name} の deriving`;
    const dictParams = checker.skolemise(scheme, (type, skolems) => {
      const rep = instantiateType(repTemplate, skolems);
      const repType = instantiateType(repScheme.type, skolems);
      const classEvidence = checker.want({ cls, type: rep }, span, origin);
      const ownEvidence = repScheme.preds
        .slice(info.context.length)
        .map((pred) => checker.want({ cls: pred.cls, type: instantiateType(pred.type, skolems) }, span, origin));
      const coercible = checker.want(
        { cls: COERCIBLE_CLASS, type: tap(tcon(COERCIBLE_TYPES), repType, type) },
        span,
        origin
      );
      const methodExpr: RExpr = {
        k: 'var',
        ref: { kind: 'global', entity: method },
        name: method.name,
        span,
        evidence: [classEvidence, ...ownEvidence],
        type: repType,
      };
      const coerceExpr: RExpr = {
        k: 'var',
        ref: { kind: 'global', entity: coerce },
        name: 'coerce',
        span,
        evidence: [coercible],
        type: tap(tcon(FUNCTION_TYPE), repType, type),
      };
      body = { k: 'app', fn: coerceExpr, arg: methodExpr, span, type };
      bodyType = type;
    });
    return {
      k: 'fun',
      binder: { kind: 'global', entity: implementation },
      clauses: [{ pats: [], rhs: { body: { k: 'plain', expr: body as RExpr }, where: { bindings: [] }, span }, span }],
      span,
      type: bodyType,
      dictParams,
    } satisfies RBinding;
  });
}

function mentionsGen(type: Type, index: number): boolean {
  const current = prune(type);
  if (current.tag === 'tgen') return current.index === index;
  if (current.tag === 'tap') return mentionsGen(current.fn, index) || mentionsGen(current.arg, index);
  return false;
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

/**
 * A method's scheme at an instance: the instance's variables and context, then the method's own variables and
 * constraints, with `classArgs`, types in the instance's variables, for the class's parameters.
 */
function instanceMethodScheme(
  info: InstanceInfo,
  typeNames: readonly string[],
  method: Scheme,
  classArgs: readonly Type[]
): Scheme {
  const offset = info.kinds.length - classArgs.length;
  const shift = (type: Type): Type =>
    mapType(type, (node) =>
      node.tag === 'tgen'
        ? node.index < classArgs.length
          ? classArgs[node.index]
          : { tag: 'tgen', index: node.index + offset }
        : node
    );
  const own = method.kinds.slice(classArgs.length);
  return {
    kinds: [...info.kinds, ...own],
    visibilities: [...info.kinds.map((): Visibility => 'specified'), ...method.visibilities.slice(classArgs.length)],
    names: [...typeNames, ...own.map((_, index) => method.names?.[classArgs.length + index] ?? 'a')],
    preds: [...info.context, ...method.preds.slice(1).map((pred) => ({ cls: pred.cls, type: shift(pred.type) }))],
    type: shift(method.type),
  };
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
      const params = checker.skolemise(scheme, (type, skolems) =>
        checker.withScopedTypes(new Map(decl.params.map((name, index) => [name, skolems[index]])), () =>
          checker.checkClauses(binding, type, 'メソッドの引数')
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
    const params = checker.skolemise(method.scheme as Scheme, (type, skolems) =>
      checker.withScopedTypes(new Map(decl.params.map((name, index) => [name, skolems[index]])), () =>
        checker.checkClauses(binding, type, 'メソッドの引数')
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

// code-gauge-allow functionCognitiveComplexity -- Each branch checks one condition GHC places on a derivable class.
function deriveInstances(checker: Checker, module: RModule, options: TypecheckOptions): DeclaredInstance[] {
  const pending: {
    decl: RDataDecl;
    cls: ClassEntity;
    info: InstanceInfo;
    span: Span;
    how: DerivingHow;
    rep?: Type;
  }[] = [];
  for (const decl of module.dataDecls) {
    for (const { cls, span, strategy, via } of decl.deriving) {
      assert(cls, 'The derived class is unresolved');
      // A constructor in GADT syntax has existential variables, a context, or a specific result type only when it says
      // so; one that reads like a plain constructor derives as one, as in GHC.
      const special = decl.cons.find(
        ({ con }) =>
          (con.exKinds?.length ?? 0) > 0 || (con.context?.length ?? 0) > 0 || (con.equalities?.length ?? 0) > 0
      )?.con;
      const how = derivingStrategy(module, options, decl, cls, strategy, span);
      // Only stock deriving reads the constructors; an anyclass instance is empty, and newtype and via ones go
      // through the representation.
      if (special && how === 'stock') {
        throw compileError(
          span,
          `構成子 ${special.name} に存在型の型変数・文脈・特定の結果の型があるので、${cls.name} を deriving できません。`
        );
      }
      if (how === 'newtype' || how === 'via') {
        const coerced = coercedDerivingHead(checker, decl, cls, how, via, span);
        const info = makeInstance(cls, coerced.headKinds, coerced.head, [], module.name, span);
        registerInstance(checker, info, span);
        pending.push({ decl, cls, info, span, how, rep: coerced.rep });
        continue;
      }
      const functorLike = how === 'stock' && FUNCTOR_LIKE_CLASSES.has(cls.name);
      const { kinds, head: fullHead } = declHead(decl);
      const headKinds = functorLike ? kinds.slice(0, -1) : kinds;
      const head = functorLike
        ? tap(tcon(decl.entity), ...headKinds.map((_, index): Type => ({ tag: 'tgen', index })))
        : fullHead;
      const info = makeInstance(cls, headKinds, head, [], module.name, span);
      registerInstance(checker, info, span);
      pending.push({ decl, cls, info, span, how });
    }
  }
  // Infer the contexts together, since derived instances of mutually recursive types depend on each other.
  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const item of pending) {
      if (item.how === 'anyclass') continue;
      const context = inferDerivedContext(checker, item.decl, item.cls, item.span, item.rep);
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
    bindings: item.how === 'stock' ? deriveInstance(item.decl, item.cls, options.derivingSupport) : [],
    span: item.span,
    rep: item.rep,
  }));
}

type DerivingHow = 'stock' | 'anyclass' | 'newtype' | 'via';

/**
 * The head of an instance that `deriving newtype` or `deriving via` derives for a data type, which leaves out as
 * many of the type's last parameters as the class's argument takes, and the type whose instance it reuses: the
 * newtype's field without those parameters, or the `via` type.
 */
function coercedDerivingHead(
  checker: Checker,
  decl: RDataDecl,
  cls: ClassEntity,
  how: 'newtype' | 'via',
  via: RType | undefined,
  span: Span
): { headKinds: Kind[]; head: Type; rep: Type } {
  if (cls.packed) throw unsupportedError(span, '多引数の型クラスの、newtype・via による deriving');
  if (decl.instanceArgs) throw unsupportedError(span, 'データ族のインスタンスの、newtype・via による deriving');
  const { kinds } = declHead(decl);
  const dropped = parameterKinds(cls.tyvarKind).length;
  if (dropped > kinds.length) {
    throw compileError(span, `${decl.entity.name} の型引数が足りないので、${cls.name} を deriving できません。`);
  }
  const headKinds = kinds.slice(0, kinds.length - dropped);
  const head = tap(tcon(decl.entity), ...headKinds.map((_, index): Type => ({ tag: 'tgen', index })));
  if (how === 'via') {
    const names = decl.params.slice(0, headKinds.length);
    const vars = new Map(names.map((name, index): [string, Type] => [name, { tag: 'tgen', index }]));
    const varKinds = new Map(names.map((name, index) => [name, headKinds[index]]));
    const rep = checker.convertType(via as RType, vars, varKinds, cls.tyvarKind);
    checker.checkKinds();
    return { headKinds, head, rep };
  }
  const rep = etaReduce(decl.cons[0].con.fieldTypes[0], kinds.length, dropped);
  if (!rep) {
    throw compileError(
      span,
      `${decl.entity.name} の中身の型から最後の型引数を外せないので、${cls.name} を newtype で deriving できません。`
    );
  }
  return { headKinds, head, rep };
}

/** A newtype's field type without the type's last `dropped` parameters, which must be its last arguments. */
function etaReduce(field: Type, arity: number, dropped: number): Type | undefined {
  let type = prune(field);
  for (let index = arity - 1; index >= arity - dropped; index--) {
    if (type.tag !== 'tap') return undefined;
    const arg = prune(type.arg);
    if (arg.tag !== 'tgen' || arg.index !== index || mentionsGen(type.fn, index)) return undefined;
    type = prune(type.fn);
  }
  for (let index = arity - dropped; index < arity; index++) if (mentionsGen(type, index)) return undefined;
  return type;
}

function deriveStandaloneInstances(checker: Checker, module: RModule, options: TypecheckOptions): DeclaredInstance[] {
  return module.standaloneDerivings.map((standalone) => {
    const instanceDecl = {
      cls: standalone.cls,
      type: standalone.type,
      context: standalone.context,
      bindings: [],
      span: standalone.span,
    };
    const undecidable = module.extensions.gates('typecheck').allows('undecidableInstances');
    if (standalone.strategy === 'via') {
      return declareInstance(checker, instanceDecl, module.name, undecidable, standalone.via).declared;
    }
    const { head } = splitRType(standalone.type);
    const candidates = head.k === 'con' ? module.dataDecls.filter((candidate) => candidate.entity === head.entity) : [];
    if (candidates.length === 0) throw unsupportedError(standalone.span, 'このプログラムで定義していない型の deriving');
    const { declared } = declareInstance(checker, instanceDecl, module.name, undecidable);
    // A data family's instances share the family; the one derived for is the instance its type matches.
    const decl = candidates.find(
      (candidate) => !candidate.instanceHead || matchType(declHead(candidate).head, declared.info.head, [])
    );
    if (!decl) {
      throw compileError(
        standalone.span,
        `${new TypePrinter().show(declared.info.head)} の data instance がありません。`
      );
    }
    const how = derivingStrategy(module, options, decl, standalone.cls, standalone.strategy, standalone.span);
    if (how === 'newtype') {
      const { rep } = coercedDerivingHead(checker, decl, standalone.cls, 'newtype', undefined, standalone.span);
      declared.rep = instantiateType(rep, splitApp(declared.info.head).args);
    }
    declared.bindings = how === 'stock' ? deriveInstance(decl, standalone.cls, options.derivingSupport) : [];
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
): DerivingHow {
  if (strategy === 'anyclass' || strategy === 'via') return strategy;
  const features = module.extensions.gates('typecheck');
  const isNewtype = decl.cons.length === 1 && decl.cons[0].con.isNewtype === true;
  if (strategy === 'newtype') {
    if (!isNewtype) {
      throw compileError(span, `${decl.entity.name} は newtype ではないので、deriving newtype を使えません。`);
    }
    return 'newtype';
  }
  const stock = options.builtins.derivableClasses.has(cls);
  const how = strategy ?? defaultStrategy(cls.name, stock, isNewtype && newtypeDerivable(decl, cls), features);
  if (how !== 'stock') {
    if (how === 'none') {
      if (['Generic', 'Data', 'Lift', 'Typeable'].includes(cls.name))
        throw unsupportedError(span, `${cls.name} の deriving`);
      throw compileError(span, `クラス ${cls.name} は deriving できません。`);
    }
    return how;
  }
  if (!stock) throw compileError(span, `クラス ${cls.name} は deriving stock できません。`);
  const derive = (
    {
      Functor: ['deriveFunctor', 'DeriveFunctor'],
      Foldable: ['deriveFoldable', 'DeriveFoldable'],
      Traversable: ['deriveTraversable', 'DeriveTraversable'],
      Lift: ['deriveLift', 'DeriveLift'],
    } as const
  )[cls.name as 'Functor'] as readonly [FeatureOf<'typecheck'>, string] | undefined;
  if (derive && !features.allows(derive[0])) {
    throw compileError(span, `${cls.name} を deriving するには、${derive[1]} の拡張が要ります。`);
  }
  checkDerivable(decl, cls, span);
  return 'stock';
}

/** Whether a newtype's field reduces to a type the class's instance can be reused at: GHC's `eta_ok`. */
function newtypeDerivable(decl: RDataDecl, cls: ClassEntity): boolean {
  if (cls.packed || decl.instanceArgs) return false;
  const { kinds } = declHead(decl);
  const dropped = parameterKinds(cls.tyvarKind).length;
  return dropped <= kinds.length && etaReduce(decl.cons[0].con.fieldTypes[0], kinds.length, dropped) !== undefined;
}

/**
 * The strategy GHC's user guide gives a deriving clause that names none ("Default deriving strategy"): a stock class
 * is derived by stock, except that for a newtype Eq, Ord, Ix and Bounded always take the newtype strategy, and
 * Functor, Foldable and Enum do under GeneralizedNewtypeDeriving when that derivation succeeds (the newtype's field
 * eta-reduces); another class by anyclass under DeriveAnyClass, else by newtype for a newtype under
 * GeneralizedNewtypeDeriving.
 */
function defaultStrategy(
  cls: string,
  stock: boolean,
  derivableNewtype: boolean,
  features: FeatureGates<'typecheck'>
): DerivingHow | 'none' {
  const generalized = derivableNewtype && features.allows('newtypeByDefault');
  if (stock) {
    if (derivableNewtype && ['Eq', 'Ord', 'Ix', 'Bounded'].includes(cls)) return 'newtype';
    if (generalized && ['Functor', 'Foldable', 'Enum'].includes(cls)) return 'newtype';
    return 'stock';
  }
  if (features.allows('anyclassByDefault')) return 'anyclass';
  return generalized ? 'newtype' : 'none';
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
  info.overlap ??= checker.defaultOverlap;
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
  if (decl.instanceHead) {
    return { kinds: decl.instanceHead.kinds, head: tap(tcon(decl.entity), ...decl.instanceHead.args) };
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

function inferDerivedContext(checker: Checker, decl: RDataDecl, cls: ClassEntity, span: Span, rep?: Type): Pred[] {
  const { kinds } = declHead(decl);
  const params = kinds.map((kind, index) => freshSkolem(kind, 1_000_000, decl.params[index] ?? `t${index}`));
  const work: Pred[] = rep ? [{ cls, type: instantiateType(rep, params) }] : [];
  // A derived instance needs the constraints DatatypeContexts puts on the type's constructors, as GHC's has them.
  for (const pred of decl.cons[0]?.con.datatypeContext ?? []) {
    work.push({ cls: pred.cls, type: instantiateType(pred.type, params) });
  }
  for (const { con } of rep ? [] : decl.cons) {
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
