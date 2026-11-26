// code-gauge-allow-file fileNcss -- Follows Rust's name resolution case by case.
import { CompileError } from '../interpreter/diagnostics';
import {
  assocItem,
  assocTypeOf,
  ITERATION_TRAITS,
  lowerAssocItemPath,
  lowerQualifiedPath,
  projectionDef,
  projectionOf,
} from './assocTypes';
import type {
  BoundAst,
  ConstItem,
  Crate,
  EnumItem,
  Expr,
  FnItem,
  Generics,
  ImplItem,
  Item,
  PathAst,
  Span,
  StructItem,
  TraitItem,
  TypeAst,
  UseItem,
  Visibility,
} from './ast';
import { checkVariantNames, defaultVariant, discriminants } from './enumItems';
import { lowerArrayType, lowerConstArg, withDefaultArgs } from './genericArgs';
import { Unifier } from './infer';
import {
  BUILTIN_ENUMS,
  builtinStruct,
  checkUnavailableStd,
  isStdMacroPath,
  renderTypeKey,
  REQUIRED_STD_METHODS,
  STD_TRAITS_LEARNERS_IMPLEMENT,
  unavailableStdItem,
} from './stdNames';
import { TraitSolver } from './traits';
import {
  adt,
  type AdtDef,
  allSupertraits,
  type AssocTypeDef,
  BOOL,
  type BuiltinAdt,
  CHAR,
  type ConstDef,
  defaultTraitArguments,
  F32,
  F64,
  type FnDef,
  freshVar,
  type ImplDef,
  INT_NAMES,
  intType,
  mapChildren,
  NEVER,
  newOpaque,
  newTypeParam,
  STR,
  type Subst,
  substitute,
  type TraitDef,
  type TraitRef,
  type Type,
  type TypeParam,
  UNIT,
  type VariantDef,
} from './types';

/** The traits a type derives, rejecting one derived twice as rustc does (E0119). */
function derivedTraits(derives: readonly { name: string; span: Span }[]): Set<string> {
  const names = new Set<string>();
  for (const { name, span } of derives) {
    if (names.has(name)) compileError(span, `${name} を2回 derive しています。`);
    names.add(name);
  }
  return names;
}

/**
 * The type parameters a generics list declares. A name may be declared once, in the list and in the item around it
 * (E0403): a later one would hide the earlier one from the lookup by name.
 */
function declareTypeParams(generics: Generics, enclosing: readonly TypeParam[] = []): TypeParam[] {
  const names = new Set<string>();
  for (const param of generics.params) {
    if (enclosing.some((outer) => outer.name === param.name)) {
      compileError(param.span, `型引数 ${param.name} は、impl の型引数と同じ名前です。`);
    }
    if (names.has(param.name)) compileError(param.span, `型引数 ${param.name} が2回宣言されています。`);
    names.add(param.name);
  }
  return generics.params.map((param) => {
    const declared = newTypeParam(param.name);
    if (param.constType) declared.constType = param.constType;
    if (param.bounds.some((bound) => bound.kind === 'maybeSized')) declared.maybeUnsized = true;
    return declared;
  });
}

export function compileError(span: Span, message: string): never {
  throw new CompileError([{ row: span.row, message }]);
}

export type TypeBinding =
  | { kind: 'adt'; def: AdtDef }
  | { kind: 'trait'; def: TraitDef }
  | { kind: 'mod'; module: Module }
  | { kind: 'alias'; params: TypeParam[]; lifetimes: string[]; resolve: () => Type }
  | { kind: 'prim'; type: Type };

export type ValueBinding =
  | { kind: 'fn'; def: FnDef }
  | { kind: 'const'; def: ConstDef }
  /** A tuple struct's or a tuple variant's constructor, or a unit struct or variant. */
  | { kind: 'ctor'; def: AdtDef; variant: number };

interface Entry<T> {
  binding: T;
  visibleWithin: Module | undefined;
}

/** A use declaration's import of one name, resolved when the name is first looked up. */
interface Import {
  path: string[];
  span: Span;
  visibleWithin: Module | undefined;
  resolving: boolean;
  types?: Entry<TypeBinding>;
  values?: Entry<ValueBinding>;
  resolved: boolean;
}

export class Module {
  readonly types = new Map<string, Entry<TypeBinding>>();
  readonly values = new Map<string, Entry<ValueBinding>>();
  readonly imports = new Map<string, Import>();
  readonly anonymousImports: Import[] = [];
  readonly globs: { path: string[]; span: Span; visibleWithin: Module | undefined }[] = [];
  readonly children: Module[] = [];

  constructor(
    readonly program: Program,
    readonly name: string,
    readonly parent: Module | undefined,
    readonly isStd: boolean,
    /** For a block's items, the scope around the block, whose names the block's items also see. */
    readonly lexicalParent?: Module
  ) {
    parent?.children.push(this);
  }

  get path(): string {
    if (!this.parent) return this.isStd ? 'std' : 'crate';
    if (this.lexicalParent) return this.parent.path;
    return `${this.parent.path}::${this.name}`;
  }

  /** The module that `self` names: a block's items belong to the module around it. */
  get namedModule(): Module {
    return this.lexicalParent ? this.lexicalParent.namedModule : this;
  }

  /** Whether `other` may see this module's private items: it is this module or one inside it. */
  isAncestorOf(other: Module): boolean {
    for (let module: Module | undefined = other; module; module = module.lexicalParent ?? module.parent) {
      if (module === this) return true;
    }
    return false;
  }
}

/** The items of a program and of the standard library, with every impl and trait. */
export class Program {
  readonly std: Module;
  readonly root: Module;
  readonly impls: ImplDef[] = [];
  readonly traits: TraitDef[] = [];
  readonly adts: AdtDef[] = [];
  readonly fns: FnDef[] = [];
  readonly consts: ConstDef[] = [];
  /** The names every module sees without importing them (`Vec`, `Some`, `Turtle`, ...). */
  readonly prelude = new Map<string, string[]>();
  readonly builtinAdts = new Map<BuiltinAdt, AdtDef>();
  readonly builtinTraits = new Map<string, TraitDef>();
  readonly staticBound: TraitDef = {
    name: "'static",
    path: "'static",
    params: [],
    self: newTypeParam('Self'),
    methods: new Map(),
    supertraits: [],
    builtin: 'Static',
    assocTypes: new Map(),
    consts: new Map(),
  };
  /** The shapes of iterators (`std::iter::shape`), which stand for std's iterator types, by name. */
  readonly shapes = new Map<string, AdtDef>();
  /** The bodies to check after every item's signature is known. */
  readonly pendingFns: FnDef[] = [];

  constructor() {
    this.std = new Module(this, 'std', undefined, true);
    this.root = new Module(this, 'crate', undefined, false);
  }

  adtDef(name: BuiltinAdt): AdtDef {
    const def = this.builtinAdts.get(name);
    if (!def) throw new Error(`Unknown builtin type ${name}`);
    return def;
  }

  traitDef(name: string): TraitDef {
    const def = this.builtinTraits.get(name);
    if (!def) throw new Error(`Unknown builtin trait ${name}`);
    return def;
  }

  builtinType(name: BuiltinAdt, args: Type[] = []): Type {
    return adt(this.adtDef(name), args);
  }

  shapeType(name: string, args: Type[] = []): Type {
    const def = this.shapes.get(name);
    if (!def) throw new Error(`Unknown iterator shape ${name}`);
    return adt(def, args);
  }

  /** An iterator of `item`s of a shape. */
  iterType(item: Type, shape: Type): Type {
    return adt(this.adtDef('Iter'), [item, shape]);
  }
}

const PRIMITIVES = new Map<string, Type>([
  ...INT_NAMES.map((name) => [name, intType(name)] as const),
  ['f32', F32],
  ['f64', F64],
  ['bool', BOOL],
  ['char', CHAR],
  ['str', STR],
]);

/** The scope that types and bounds are lowered in: a module and the type parameters and `Self` around them. */
export interface TypeScope {
  module: Module;
  params: Map<string, TypeParam>;
  selfType: Type | undefined;
  evaluatingLengths?: Set<Expr>;
  /** In a function's parameters, `impl Trait` adds an anonymous type parameter here. */
  implParams?: TypeParam[];
  /** In a function's result, `impl Trait` is an opaque type. */
  returnOf?: FnDef;
  /** Inside a function body, `_` is a type to infer. */
  allowInfer?: boolean;
  /** For the path of an expression (`Point { x: 1 }`), whose omitted type arguments are inferred, unlike a written type's. */
  inferOmittedArgs?: boolean;
  /**
   * In a function's signature, `I::Item` of a parameter bounded by `Iterator` or `IntoIterator` without its `Item` adds
   * a type parameter here that the bound sets as `Item`, as if written `I: Iterator<Item = J>`.
   */
  assocParams?: TypeParam[];
  /** In a function's signature, its own type parameters, whose associated types may become `assocParams`. */
  ownParams?: TypeParam[];
  /** In a trait impl, its trait, whose associated types `Self::Name` names. */
  implTrait?: TraitRef;
}

// ---------------------------------------------------------------------------------------------------------------------
// Collecting items

/** Declares the items of a module, leaving their signatures for {@link lowerSignatures}. */
export class ItemCollector {
  /** Each declared item's work that needs every name declared first. */
  private readonly lowering: (() => void)[] = [];
  /** The self types of impls, which their methods' signatures need first. */
  private readonly implLowering: (() => void)[] = [];
  private readonly traitDefaults: (() => void)[] = [];
  private readonly bodies: (() => void)[] = [];

  constructor(readonly program: Program) {}

  collectCrate(crate: Crate, module: Module): void {
    this.collectItems(crate.items, module);
  }

  /** Lowers the signatures of every item collected so far. */
  finish(): void {
    for (const lower of this.traitDefaults.splice(0)) lower();
    for (const lower of this.implLowering.splice(0)) lower();
    for (const lower of this.lowering.splice(0)) lower();
    for (const body of this.bodies.splice(0)) body();
  }

  // code-gauge-allow functionNcss -- Follows Rust's name resolution case by case.
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of item.
  collectItems(items: Item[], module: Module): void {
    for (const item of items) {
      switch (item.kind) {
        case 'fn': {
          const def = this.fnDef(item, module, undefined, undefined);
          if (module.isStd) def.nativeKey = `${module.path}::${item.name}`;
          this.declareValue(module, item.name, { kind: 'fn', def }, item.vis, item.span);
          break;
        }
        case 'struct': {
          this.structItem(item, module);
          break;
        }
        case 'enum': {
          this.enumItem(item, module);
          break;
        }
        case 'trait': {
          this.traitItem(item, module);
          break;
        }
        case 'impl': {
          this.implItem(item, module);
          break;
        }
        case 'const': {
          this.declareValue(
            module,
            item.name,
            { kind: 'const', def: this.constDef(item, module, undefined) },
            item.vis,
            item.span
          );
          break;
        }
        case 'mod': {
          if (module.types.has(item.name)) compileError(item.span, `${item.name} という名前が2回宣言されています。`);
          const child = new Module(this.program, item.name, module, module.isStd);
          module.types.set(item.name, {
            binding: { kind: 'mod', module: child },
            visibleWithin: visibilityScope(item.vis, module, item.span),
          });
          this.collectItems(item.items, child);
          break;
        }
        case 'use': {
          this.useItem(item, module);
          break;
        }
        case 'typeAlias': {
          let resolved: Type | undefined;
          let resolving = false;
          const params = declareTypeParams(item.generics);
          const scope: TypeScope = {
            module,
            params: new Map(params.map((param) => [param.name, param])),
            selfType: undefined,
          };
          this.declareType(
            module,
            item.name,
            {
              kind: 'alias',
              params,
              lifetimes: item.generics.lifetimes,
              resolve: () => {
                if (resolved) return resolved;
                if (resolving) compileError(item.span, `型の別名 ${item.name} が、自分自身を使っています（E0391）。`);
                resolving = true;
                try {
                  resolved = lowerType(item.type, scope);
                } finally {
                  resolving = false;
                }
                return resolved;
              },
            },
            item.vis,
            item.span
          );
          break;
        }
      }
    }
  }

  private declareType(module: Module, name: string, binding: TypeBinding, vis: Visibility, span: Span): void {
    if (module.types.has(name) || module.imports.get(name)?.types) {
      compileError(span, `${name} という名前が2回宣言されています。`);
    }
    module.types.set(name, { binding, visibleWithin: visibilityScope(vis, module, span) });
  }

  private declareValue(module: Module, name: string, binding: ValueBinding, vis: Visibility, span: Span): void {
    if (module.values.has(name)) compileError(span, `${name} という名前が2回宣言されています。`);
    module.values.set(name, { binding, visibleWithin: visibilityScope(vis, module, span) });
  }

  private structItem(item: StructItem, module: Module): void {
    const def: AdtDef = {
      name: item.name,
      path: module.isStd ? item.name : `${module.path}::${item.name}`,
      kind: 'struct',
      params: declareTypeParams(item.generics),
      variants: [],
      writtenFields: item.fields,
      derives: derivedTraits(item.attrs.derives),
      span: item.span,
      lifetimeParams: item.generics.lifetimes,
      module,
      isUnion: item.isUnion,
    };
    const builtin = module.isStd ? builtinStruct(module, item.name) : undefined;
    if (builtin) {
      def.builtin = builtin;
      this.program.builtinAdts.set(builtin, def);
    }
    if (module.isStd && module.name === 'shape') this.program.shapes.set(item.name, def);
    this.program.adts.push(def);
    this.declareType(module, item.name, { kind: 'adt', def }, item.vis, item.span);
    if (item.shape !== 'named') {
      this.declareValue(module, item.name, { kind: 'ctor', def, variant: 0 }, item.vis, item.span);
    }
    this.adtDefaults(def, module, item.generics);
    this.lowering.push(() => {
      const scope = this.adtScope(def, module, item.generics);
      def.variants.push({
        name: item.name,
        index: 0,
        shape: item.shape,
        fields: item.fields.map((field) => ({
          name: field.name,
          type: lowerType(field.type, scope),
          visibleWithin: visibilityScope(field.vis, module.namedModule, field.span),
          span: field.span,
        })),
        discriminant: 0n,
      });
      checkDuplicateFields(item.fields);
    });
  }

  private enumItem(item: EnumItem, module: Module): void {
    const def: AdtDef = {
      name: item.name,
      path: module.isStd ? item.name : `${module.path}::${item.name}`,
      kind: 'enum',
      params: declareTypeParams(item.generics),
      variants: [],
      derives: derivedTraits(item.attrs.derives),
      span: item.span,
      lifetimeParams: item.generics.lifetimes,
      module,
    };
    if (module.isStd && BUILTIN_ENUMS[item.name]) {
      def.builtin = BUILTIN_ENUMS[item.name];
      this.program.builtinAdts.set(def.builtin, def);
    }
    this.program.adts.push(def);
    this.declareType(module, item.name, { kind: 'adt', def }, item.vis, item.span);
    def.defaultVariant = defaultVariant(item);
    checkVariantNames(item);
    for (const [index, discriminant] of discriminants(item).entries()) {
      const variant = item.variants[index];
      def.variants.push({ name: variant.name, index, shape: variant.shape, fields: [], discriminant });
    }
    this.adtDefaults(def, module, item.generics);
    this.lowering.push(() => {
      const scope = this.adtScope(def, module, item.generics);
      for (const [index, variant] of item.variants.entries()) {
        def.variants[index].fields = variant.fields.map((field) => ({
          name: field.name,
          type: lowerType(field.type, scope),
          visibleWithin: undefined,
          span: field.span,
        }));
        checkDuplicateFields(variant.fields);
      }
    });
  }

  /** Lowers the default types of a type's parameters (`struct P<T = i32>`), before any signature uses the type. */
  private adtDefaults(def: AdtDef, module: Module, generics: Generics): void {
    const params = new Map(def.params.map((param) => [param.name, param]));
    for (const [index, param] of generics.params.entries()) {
      const written = param.defaultType;
      if (!written) continue;
      this.traitDefaults.push(() => {
        def.params[index].defaultType = lowerType(written, { module, params, selfType: undefined });
      });
    }
  }

  private adtScope(def: AdtDef, module: Module, generics: Generics): TypeScope {
    const params = new Map(def.params.map((param) => [param.name, param]));
    const scope: TypeScope = {
      module,
      params,
      selfType: adt(
        def,
        def.params.map((param) => ({ kind: 'param', param }))
      ),
    };
    lowerTypeParamBounds(def.params, generics, scope);
    addWherePredicates(generics, scope);
    return scope;
  }

  // code-gauge-allow functionNcss -- Collects traits and lowers their generic and inherited bounds together.
  // code-gauge-allow functionCognitiveComplexity -- Declares methods, associated types and constants of a trait.
  private traitItem(item: TraitItem, module: Module): void {
    const self = newTypeParam('Self', true);
    const def: TraitDef = {
      name: item.name,
      path: module.isStd && module.path !== 'std::io' ? item.name : `${module.path}::${item.name}`,
      span: item.span,
      params: declareTypeParams(item.generics),
      self,
      methods: new Map(),
      supertraits: [],
      module,
      assocTypes: new Map(),
      consts: new Map(),
    };
    if (module.isStd && module.path !== 'std::io') {
      def.builtin = item.name;
      this.program.builtinTraits.set(item.name, def);
    }
    this.program.traits.push(def);
    this.declareType(module, item.name, { kind: 'trait', def }, item.vis, item.span);
    const selfType: Type = { kind: 'param', param: self };
    self.bounds = [{ trait: def, args: def.params.map((param) => ({ kind: 'param', param })) }];
    for (const method of item.methods) {
      if (def.methods.has(method.name)) compileError(method.span, `メソッド ${method.name} が2回宣言されています。`);
      const fn = this.fnDef(method, module, undefined, def);
      fn.isDefault = true;
      if (module.isStd) fn.nativeKey = `${def.path}::${method.name}`;
      def.methods.set(method.name, fn);
    }
    for (const assoc of item.assocTypes) {
      if (def.assocTypes.has(assoc.name)) compileError(assoc.span, `関連型 ${assoc.name} が2回宣言されています。`);
      def.assocTypes.set(assoc.name, {
        name: assoc.name,
        bounds: [],
        projection: projectionDef(def, assoc.name, module),
        params: declareTypeParams(assoc.generics, def.params),
      });
    }
    for (const constant of item.consts) {
      if (def.consts.has(constant.name) || def.methods.has(constant.name)) {
        compileError(constant.span, `${constant.name} が2回宣言されています。`);
      }
      const constDef = this.constDef(constant, module, undefined, def);
      def.consts.set(constant.name, constDef);
    }
    const params = new Map(def.params.map((param) => [param.name, param]));
    const scope: TypeScope = { module, params, selfType };
    for (const assoc of item.assocTypes) {
      this.lowering.push(() => {
        (def.assocTypes.get(assoc.name) as AssocTypeDef).bounds = assoc.bounds.flatMap((bound) =>
          bound.kind === 'trait' ? [lowerBound(bound, scope, projectionOf(def, assoc.name, selfType))] : []
        );
      });
    }
    for (const [index, param] of item.generics.params.entries()) {
      const defaultType = param.defaultType;
      if (defaultType) this.traitDefaults.push(() => (def.params[index].defaultType = lowerType(defaultType, scope)));
    }
    this.lowering.unshift(() => {
      lowerTypeParamBounds(def.params, item.generics, scope);
      def.supertraits = item.supertraits.flatMap((bound) => lowerBoundIfTrait(bound, scope, selfType));
      addWherePredicates(item.generics, scope, (param, bounds) => {
        if (param !== self) return false;
        def.supertraits.push(...bounds);
        return true;
      });
      self.bounds.push(...def.supertraits);
    });
  }

  // code-gauge-allow functionCognitiveComplexity -- Follows Rust's name resolution case by case.
  // code-gauge-allow functionNcss -- Follows Rust's name resolution case by case.
  private implItem(item: ImplItem, module: Module): void {
    const impl: ImplDef = {
      params: declareTypeParams(item.generics),
      trait: undefined,
      selfType: UNIT,
      methods: new Map(),
      consts: new Map(),
      assocTypes: new Map(),
      lifetimeBounds: item.generics.lifetimeBounds,
      module,
      span: item.span,
    };
    this.program.impls.push(impl);
    const prefix = module.isStd ? renderTypeKey(item.selfType, item.generics) : undefined;
    for (const method of item.methods) {
      if (impl.methods.has(method.name)) compileError(method.span, `メソッド ${method.name} が2回宣言されています。`);
      const fn = this.fnDef(method, module, impl, undefined);
      if (prefix) fn.nativeKey = `${prefix}::${method.name}`;
      impl.methods.set(method.name, fn);
    }
    for (const constant of item.consts) this.implConst(constant, module, impl);
    this.implLowering.push(() => {
      const params = new Map(impl.params.map((param) => [param.name, param]));
      const scope: TypeScope = { module, params, selfType: undefined };
      impl.selfType = lowerType(item.selfType, scope);
      scope.selfType = impl.selfType;
      lowerTypeParamBounds(impl.params, item.generics, scope);
      addWherePredicates(item.generics, scope);
      if (item.trait) {
        const binding = resolveTypePath(
          item.trait.segments.map((segment) => segment.name),
          module,
          item.trait.span
        );
        if (binding.kind === 'trait') this.checkStdTraitImpl(item, impl, binding.def);
        const trait = resolveTraitPath(item.trait, scope, impl.selfType);
        impl.trait = trait;
        scope.implTrait = trait;
        lowerImplAssocTypes(item, impl, trait, scope);
        this.checkTraitImpl(item, impl, trait.trait);
      } else if (!module.isStd) {
        const self = impl.selfType;
        if (self.kind !== 'adt' || self.def.module === undefined || (self.def.module as Module).isStd) {
          compileError(
            item.span,
            `型 ${describeImplType(self)} に、トレイトなしの impl は書けません（自分で宣言した型にだけ書けます）。`
          );
        }
      }
    });
  }

  /** Rejects impls of the standard library's traits that learning programs do not implement here. */
  private checkStdTraitImpl(item: ImplItem, impl: ImplDef, trait: TraitDef): void {
    const traitModule = trait.module as Module;
    if (traitModule.isStd && !(impl.module as Module).isStd && !STD_TRAITS_LEARNERS_IMPLEMENT.has(trait.name)) {
      compileError(item.span, `標準ライブラリのトレイト ${trait.name} の実装は、この採点環境では使えません。`);
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Follows Rust's name resolution case by case.
  private checkTraitImpl(item: ImplItem, impl: ImplDef, trait: TraitDef): void {
    for (const method of item.methods) {
      if (!trait.methods.has(method.name)) {
        compileError(method.span, `メソッド ${method.name} は、トレイト ${trait.name} にありません。`);
      }
    }
    for (const constant of item.consts) {
      if (!trait.consts.has(constant.name)) {
        compileError(constant.span, `定数 ${constant.name} は、トレイト ${trait.name} にありません（E0438）。`);
      }
    }
    for (const name of trait.assocTypes.keys()) {
      if (!impl.assocTypes.has(name))
        compileError(item.span, `トレイト ${trait.name} の関連型 ${name} を書いてください（E0046）。`);
    }
    for (const [name, constant] of trait.consts) {
      if (!constant.ast.value && !impl.consts.has(name)) {
        compileError(item.span, `トレイト ${trait.name} の定数 ${name} を書いてください（E0046）。`);
      }
    }
    if (this.program.root.isAncestorOf(trait.module as Module) || (impl.module as Module).isStd) {
      for (const [name, method] of trait.methods) {
        if (!method.ast?.body && !impl.methods.has(name) && !(trait.module as Module).isStd) {
          compileError(item.span, `トレイト ${trait.name} のメソッド ${name} を実装してください。`);
        }
      }
    } else {
      for (const name of REQUIRED_STD_METHODS[trait.name] ?? []) {
        if (!impl.methods.has(name))
          compileError(item.span, `トレイト ${trait.name} のメソッド ${name} を実装してください。`);
      }
      if (!STD_TRAITS_LEARNERS_IMPLEMENT.has(trait.name)) {
        compileError(item.span, `標準ライブラリのトレイト ${trait.name} の実装は、この採点環境では使えません。`);
      }
    }
  }

  private implConst(constant: ConstItem, module: Module, impl: ImplDef): void {
    if (impl.consts.has(constant.name) || impl.methods.has(constant.name)) {
      compileError(constant.span, `${constant.name} が2回宣言されています。`);
    }
    impl.consts.set(constant.name, this.constDef(constant, module, impl));
  }

  private constDef(item: ConstItem, module: Module, impl: ImplDef | undefined, trait?: TraitDef): ConstDef {
    const def: ConstDef = { name: item.name, type: UNIT, ast: item, module, impl, trait };
    this.program.consts.push(def);
    this.lowering.push(() => {
      const scope: TypeScope = {
        module,
        params: new Map((impl?.params ?? trait?.params ?? []).map((param) => [param.name, param])),
        selfType: trait ? { kind: 'param', param: trait.self } : impl?.selfType,
        implTrait: impl?.trait,
      };
      def.type = lowerType(item.type, scope);
    });
    return def;
  }

  fnDef(item: FnItem, module: Module, impl: ImplDef | undefined, trait: TraitDef | undefined): FnDef {
    const parentParams = impl?.params ?? (trait ? [...trait.params] : []);
    const own = declareTypeParams(item.generics, parentParams);
    const def: FnDef = {
      name: item.name,
      params: [...parentParams, ...own],
      parentParamCount: parentParams.length,
      selfMode: item.selfParam?.mode,
      selfWrapper: item.selfParam?.wrapper,
      paramTypes: [],
      ret: UNIT,
      ast: item,
      impl,
      trait,
      module,
    };
    if (trait) def.params.unshift(trait.self);
    if (trait) def.parentParamCount++;
    this.program.fns.push(def);
    if (item.selfParam && !impl && !trait) {
      compileError(item.selfParam.span, 'self は、impl やトレイトの中の関数にだけ書けます。');
    }
    this.lowering.push(() => this.lowerFnSignature(def, item, module, own));
    if (!module.isStd && item.body) this.program.pendingFns.push(def);
    return def;
  }

  private lowerFnSignature(def: FnDef, item: FnItem, module: Module, own: TypeParam[]): void {
    const { impl, trait } = def;
    const params = new Map(def.params.map((param) => [param.name, param]));
    if (trait) params.delete('Self');
    const selfType: Type | undefined = trait ? { kind: 'param', param: trait.self } : impl?.selfType;
    const assocParams: TypeParam[] = [];
    const scope: TypeScope = { module, params, selfType, assocParams, ownParams: own, implTrait: impl?.trait };
    for (const [index, param] of item.generics.params.entries()) {
      own[index].bounds = param.bounds.flatMap((bound) =>
        lowerBoundIfTrait(bound, scope, { kind: 'param', param: own[index] })
      );
    }
    addWherePredicates(item.generics, scope, (param, bounds) => {
      // A method's bounds on its impl's parameters constrain only the method.
      if (own.includes(param) || assocParams.includes(param)) return false;
      def.extraBounds ??= [];
      def.extraBounds.push(...bounds.map((bound) => ({ param, bound })));
      return true;
    });
    const implParams: TypeParam[] = [];
    const paramScope: TypeScope = { ...scope, implParams };
    def.paramTypes = item.params.map((param) => lowerType(param.type, paramScope));
    def.params.push(...implParams);
    def.ret = item.ret ? lowerType(item.ret, { ...scope, returnOf: def }) : UNIT;
    for (const param of own) assocItem(param, scope);
    def.params.push(...assocParams);
    if (item.name === 'main' && module === this.program.root && !impl && !trait) checkMainSignature(item);
  }

  private useItem(item: UseItem, module: Module): void {
    for (const entry of item.entries) {
      if (entry.glob) {
        module.globs.push({
          path: entry.path,
          span: entry.span,
          visibleWithin: visibilityScope(item.vis, module, item.span),
        });
        continue;
      }
      const name = entry.alias ?? entry.path.at(-1) ?? '';
      if ((name === 'self' || name === 'super' || name === 'crate') && entry.path.length === 1) {
        compileError(entry.span, `use ${name}; は書けません。`);
      }
      const imported: Import = {
        path: entry.path,
        span: entry.span,
        visibleWithin: visibilityScope(item.vis, module, item.span),
        resolving: false,
        resolved: false,
      };
      if (name === '_') {
        module.anonymousImports.push(imported);
      } else {
        if (module.imports.has(name)) compileError(entry.span, `${name} という名前が2回 use されています。`);
        module.imports.set(name, imported);
      }
    }
  }
}

/** The associated types of a trait impl (`type Item<T> = Vec<T>;`), lowered with their own parameters in scope. */
function lowerImplAssocTypes(item: ImplItem, impl: ImplDef, trait: TraitRef, scope: TypeScope): void {
  for (const assoc of item.assocTypes) {
    const declared = trait.trait.assocTypes.get(assoc.name);
    if (!declared)
      compileError(assoc.span, `関連型 ${assoc.name} は、トレイト ${trait.trait.name} にありません（E0437）。`);
    if (impl.assocTypes.has(assoc.name)) compileError(assoc.span, `関連型 ${assoc.name} が2回あります。`);
    const own = declareTypeParams(assoc.generics, impl.params);
    if (own.length !== declared.params.length) {
      compileError(assoc.span, `関連型 ${assoc.name} の型引数の数が、トレイトの宣言と合いません（E0049）。`);
    }
    const params = new Map([...scope.params, ...own.map((param): [string, TypeParam] => [param.name, param])]);
    impl.assocTypes.set(assoc.name, lowerType(assoc.type, { ...scope, params }));
    if (own.length > 0) (impl.assocTypeParams ??= new Map()).set(assoc.name, own);
  }
}

function checkMainSignature(item: FnItem): void {
  if (item.generics.params.length > 0) compileError(item.span, 'main 関数には型引数を書けません。');
  if (item.params.length > 0) compileError(item.span, 'main 関数には引数を書けません。');
  if (item.isAsync) compileError(item.span, 'main 関数を async にはできません（E0752）。');
}

function checkDuplicateFields(fields: { name: string; span: Span }[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) compileError(field.span, `フィールド ${field.name} が2回宣言されています。`);
    names.add(field.name);
  }
}

function describeImplType(type: Type): string {
  if (type.kind === 'adt') return type.def.name;
  if (type.kind === 'int' || type.kind === 'float') return type.name;
  return type.kind;
}

function lowerTypeParamBounds(params: TypeParam[], generics: Generics, scope: TypeScope): void {
  for (const [index, param] of generics.params.entries()) {
    const target = params[index];
    target.bounds = param.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, { kind: 'param', param: target }));
  }
}

/**
 * Adds the bounds of a `where` clause to the type parameters they constrain, unless `elsewhere` takes them (a
 * method's bounds on its impl's parameters).
 */
function addWherePredicates(
  generics: Generics,
  scope: TypeScope,
  elsewhere?: (param: TypeParam, bounds: TraitRef[]) => boolean
): void {
  for (const predicate of generics.where) {
    const type = lowerType(predicate.type, scope);
    if (type.kind !== 'param') {
      compileError(predicate.span, 'where には、型引数の境界だけを書いてください。');
    }
    const bounds = predicate.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type));
    if (elsewhere?.(type.param, bounds)) continue;
    type.param.bounds.push(...bounds);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Name resolution

const EXTERN_CRATES = new Set(['std', 'core', 'alloc']);

/** Looks up a name in a scope's type namespace: its items and imports, the scopes around a block, and the prelude. */
export function lookupType(module: Module, name: string, span: Span): TypeBinding | undefined {
  return lookupTypeEntry(module, name, span)?.binding;
}

function lookupTypeEntry(module: Module, name: string, span: Span, excluded?: Import): Entry<TypeBinding> | undefined {
  for (let scope: Module | undefined = module; scope; scope = scope.lexicalParent) {
    const found = ownType(scope, name, span, new Set(), excluded);
    if (found) return found;
  }
  if (module.isStd) {
    const found = stdIndex(module.program, 'type').get(name);
    if (found) return { binding: found as TypeBinding, visibleWithin: undefined };
  }
  const prim = PRIMITIVES.get(name);
  const preludePath = module.program.prelude.get(name);
  if (preludePath) {
    const found = resolveAbsolute(module.program, preludePath, span, 'type');
    if (found) return { binding: found as TypeBinding, visibleWithin: undefined };
  }
  if (prim) return { binding: { kind: 'prim', type: prim }, visibleWithin: undefined };
  if (EXTERN_CRATES.has(name))
    return { binding: { kind: 'mod', module: module.program.std }, visibleWithin: undefined };
  return undefined;
}

export function lookupValue(module: Module, name: string, span: Span): ValueBinding | undefined {
  return lookupValueEntry(module, name, span)?.binding;
}

function lookupValueEntry(
  module: Module,
  name: string,
  span: Span,
  excluded?: Import
): Entry<ValueBinding> | undefined {
  for (let scope: Module | undefined = module; scope; scope = scope.lexicalParent) {
    const found = ownValue(scope, name, span, new Set(), excluded);
    if (found) return found;
  }
  if (module.isStd) {
    const found = stdIndex(module.program, 'value').get(name);
    if (found) return { binding: found as ValueBinding, visibleWithin: undefined };
  }
  const preludePath = module.program.prelude.get(name);
  if (preludePath) {
    const found = resolveAbsolute(module.program, preludePath, span, 'value');
    if (found) return { binding: found as ValueBinding, visibleWithin: undefined };
  }
  return undefined;
}

export function lookupScalarConstant(
  path: PathAst,
  scope: TypeScope
): { def: ConstDef; selfType: Type | undefined } | undefined {
  const { module } = scope;
  const prefix = path.segments.slice(0, -1);
  const name = path.segments.at(-1)!.name;
  if (prefix.length === 0) {
    const binding = lookupValue(module, name, path.span);
    return binding?.kind === 'const' ? { def: binding.def, selfType: undefined } : undefined;
  }
  const owner =
    prefix.length === 1 && prefix[0].name === 'Self'
      ? undefined
      : resolveTypePath(
          prefix.map((segment) => segment.name),
          module,
          path.span
        );
  if (owner?.kind === 'mod') {
    const entry = ownValue(owner.module, name, path.span, new Set());
    checkVisible(entry, module.namedModule, name, path.span);
    return entry?.binding.kind === 'const' ? { def: entry.binding.def, selfType: undefined } : undefined;
  }
  const selfType = owner ? lowerPathType({ ...path, segments: prefix }, scope) : scope.selfType;
  if (!selfType) return undefined;
  const found = lookupAssociatedConst(
    new TraitSolver(module.program, new Unifier()),
    module,
    selfType,
    name,
    path.span
  );
  return found && { def: found.def, selfType };
}

export function lookupAssociatedConst(
  solver: TraitSolver,
  module: Module,
  selfType: Type,
  name: string,
  span: Span
): { def: ConstDef; subst: Subst } | undefined {
  for (const impl of module.program.impls) {
    const def = impl.consts.get(name);
    if (!def) continue;
    const subst = solver.matchImpl(impl, selfType);
    if (!subst) continue;
    if (
      !def.module.isStd &&
      !visibleFrom(visibilityScope(def.ast.vis, def.module.namedModule, def.ast.span), module.namedModule)
    ) {
      compileError(span, `${name} は非公開です（pub が付いていません）。`);
    }
    return { def, subst };
  }
  return undefined;
}

/** Resolves every import of a module and the modules in it, reporting imports that name nothing, as rustc does. */
export function resolveImports(module: Module): void {
  for (const entry of module.imports.values()) resolveImport(module, entry);
  for (const entry of module.anonymousImports) resolveImport(module, entry);
  for (const glob of module.globs) {
    const target = resolveTypePath(glob.path, module, glob.span);
    if (target.kind === 'mod' && target.module.isStd) checkUnavailableStd(['std', ...glob.path.slice(1)], glob.span);
  }
  for (const child of module.children) if (!child.lexicalParent) resolveImports(child);
}

const stdIndexes = new WeakMap<Program, { type: Map<string, unknown>; value: Map<string, unknown> }>();

/** The standard library's declarations see each other's items by name, wherever they are declared. */
// code-gauge-allow functionCognitiveComplexity -- Follows Rust's name resolution case by case.
function stdIndex(program: Program, ns: 'type' | 'value'): Map<string, unknown> {
  let index = stdIndexes.get(program);
  if (!index) {
    index = { type: new Map(), value: new Map() };
    const visit = (module: Module): void => {
      for (const [name, entry] of module.types) {
        if (!index!.type.has(name) && entry.binding.kind !== 'mod' && entry.binding.kind !== 'alias') {
          index!.type.set(name, entry.binding);
        }
        if (entry.binding.kind === 'mod') visit(entry.binding.module);
      }
      for (const [name, entry] of module.values) if (!index!.value.has(name)) index!.value.set(name, entry.binding);
    };
    visit(program.std);
    const option = index.type.get('Option') as TypeBinding | undefined;
    const result = index.type.get('Result') as TypeBinding | undefined;
    if (option?.kind === 'adt') {
      index.value.set('Some', { kind: 'ctor', def: option.def, variant: 1 });
      index.value.set('None', { kind: 'ctor', def: option.def, variant: 0 });
    }
    if (result?.kind === 'adt') {
      index.value.set('Ok', { kind: 'ctor', def: result.def, variant: 0 });
      index.value.set('Err', { kind: 'ctor', def: result.def, variant: 1 });
    }
    stdIndexes.set(program, index);
  }
  return index[ns];
}

function resolveAbsolute(
  program: Program,
  path: string[],
  span: Span,
  ns: 'type' | 'value'
): TypeBinding | ValueBinding | undefined {
  let module = program.std;
  for (const segment of path.slice(1, -1)) {
    const next = ownType(module, segment, span, new Set());
    if (next?.binding.kind !== 'mod') return undefined;
    module = next.binding.module;
  }
  const last = path.at(-1) as string;
  return ns === 'type'
    ? ownType(module, last, span, new Set())?.binding
    : ownValue(module, last, span, new Set())?.binding;
}

function ownType(
  module: Module,
  name: string,
  span: Span,
  visiting: Set<Module>,
  excluded?: Import
): Entry<TypeBinding> | undefined {
  const own = module.types.get(name);
  if (own) return own;
  const imported = module.imports.get(name);
  if (imported && imported !== excluded) {
    resolveImport(module, imported);
    if (imported.types) return imported.types;
  }
  return fromGlobs(module, name, span, visiting, 'type') as Entry<TypeBinding> | undefined;
}

function ownValue(
  module: Module,
  name: string,
  span: Span,
  visiting: Set<Module>,
  excluded?: Import
): Entry<ValueBinding> | undefined {
  const own = module.values.get(name);
  if (own) return own;
  const imported = module.imports.get(name);
  if (imported && imported !== excluded) {
    resolveImport(module, imported);
    if (imported.values) return imported.values;
  }
  return fromGlobs(module, name, span, visiting, 'value') as Entry<ValueBinding> | undefined;
}

export function* globTypeNames(module: Module, seen = new Set<Module>()): Iterable<string> {
  if (seen.has(module)) return;
  seen.add(module);
  for (const glob of module.globs) {
    const target = globTarget(module, glob);
    if (target.kind !== 'mod') continue;
    yield* target.module.types.keys();
    yield* target.module.imports.keys();
    yield* globTypeNames(target.module, seen);
  }
}

export function* globAnonymousTraits(module: Module, requester = module, seen = new Set<Module>()): Iterable<TraitDef> {
  if (seen.has(module)) return;
  seen.add(module);
  for (const glob of module.globs) {
    if (!visibleFrom(glob.visibleWithin, requester)) continue;
    const target = globTarget(module, glob);
    if (target.kind !== 'mod') continue;
    for (const entry of target.module.anonymousImports) {
      if (!visibleFrom(entry.visibleWithin, requester)) continue;
      resolveImport(target.module, entry);
      const binding = entry.types?.binding;
      if (binding?.kind === 'trait') yield binding.def;
    }
    yield* globAnonymousTraits(target.module, requester, seen);
  }
}

/** The modules resolving their glob imports' paths, which must not look in those same globs. */
const resolvingGlobs = new Set<Module>();

function fromGlobs(
  module: Module,
  name: string,
  span: Span,
  visiting: Set<Module>,
  ns: 'type' | 'value'
): Entry<TypeBinding | ValueBinding> | undefined {
  if (visiting.has(module) || module.globs.length === 0 || resolvingGlobs.has(module)) return undefined;
  visiting.add(module);
  try {
    let match: Entry<TypeBinding | ValueBinding> | undefined;
    for (const glob of module.globs) {
      const found = globBinding(module, glob, name, span, visiting, ns);
      if (!found) continue;
      if (match && !sameGlobBinding(match.binding, found.binding)) {
        compileError(span, `${name} は、複数の use ...::* で取り込まれているので、一つに決まりません。`);
      }
      if (!match || (match.visibleWithin && visibleFrom(found.visibleWithin, match.visibleWithin))) match = found;
    }
    return match;
  } finally {
    visiting.delete(module);
  }
}

function globBinding(
  module: Module,
  glob: Module['globs'][number],
  name: string,
  span: Span,
  visiting: Set<Module>,
  ns: 'type' | 'value'
): Entry<TypeBinding | ValueBinding> | undefined {
  const target = globTarget(module, glob);
  if (target.kind === 'mod') {
    const found =
      ns === 'type' ? ownType(target.module, name, span, visiting) : ownValue(target.module, name, span, visiting);
    if (!found || !visibleFrom(found.visibleWithin, module)) return undefined;
    return { ...found, visibleWithin: narrowerScope(found.visibleWithin, glob.visibleWithin) };
  }
  if (target.kind !== 'adt' || target.def.kind !== 'enum' || ns !== 'value') return undefined;
  const variant = target.def.variants.find((candidate) => candidate.name === name);
  if (!variant) return undefined;
  return { binding: { kind: 'ctor', def: target.def, variant: variant.index }, visibleWithin: glob.visibleWithin };
}

function sameGlobBinding(a: TypeBinding | ValueBinding, b: TypeBinding | ValueBinding): boolean {
  if (a === b) return true;
  if (a.kind === 'ctor' && b.kind === 'ctor') return a.def === b.def && a.variant === b.variant;
  return a.kind === 'mod' && b.kind === 'mod' && a.module === b.module;
}

function globTarget(module: Module, glob: Module['globs'][number]): TypeBinding {
  resolvingGlobs.add(module);
  try {
    return resolveTypePath(glob.path, module, glob.span);
  } finally {
    resolvingGlobs.delete(module);
  }
}

function resolveImport(module: Module, entry: Import): void {
  if (entry.resolved) return;
  if (entry.resolving) compileError(entry.span, `use ${entry.path.join('::')} が循環しています。`);
  entry.resolving = true;
  try {
    const { path, span } = entry;
    const last = path.at(-1) as string;
    if (last === 'self') {
      const target = resolveTypePath(path.slice(0, -1), module, span);
      entry.types = { binding: target, visibleWithin: entry.visibleWithin };
    } else if (path.length === 1 && EXTERN_CRATES.has(last)) {
      entry.types = { binding: { kind: 'mod', module: module.program.std }, visibleWithin: entry.visibleWithin };
    } else {
      const { types, values } = resolveImportedName(module, entry);
      if (!types && !values && !isStdMacroPath(path)) {
        compileError(span, `use ${path.join('::')} の ${last} が見つかりません。`);
      }
      if (types) entry.types = scopedImport(types, entry);
      if (values) entry.values = scopedImport(values, entry);
    }
    entry.resolved = true;
  } finally {
    entry.resolving = false;
  }
}

function scopedImport<T>(source: Entry<T>, target: Import): Entry<T> {
  const { visibleWithin } = target;
  const sourceScope = source.visibleWithin;
  if (sourceScope && (!visibleWithin || !visibleFrom(sourceScope, visibleWithin))) {
    compileError(target.span, 'use では、元の項目より広い範囲に公開できません。');
  }
  return { binding: source.binding, visibleWithin };
}

function resolveImportedName(
  module: Module,
  entry: Import
): { types?: Entry<TypeBinding>; values?: Entry<ValueBinding> } {
  const { path, span } = entry;
  const last = path.at(-1) as string;
  const parent = path.length > 1 ? resolveTypePath(path.slice(0, -1), module, span) : undefined;
  if (!parent) {
    return { types: lookupTypeEntry(module, last, span, entry), values: lookupValueEntry(module, last, span, entry) };
  }
  if (parent.kind === 'mod') {
    const typeEntry = ownType(parent.module, last, span, new Set());
    const valueEntry = ownValue(parent.module, last, span, new Set());
    if (!typeEntry && !valueEntry && parent.module.isStd && !isStdMacroPath(path))
      unavailableStdItem([...parent.module.path.split('::'), last], span);
    checkVisible(typeEntry, module, last, span);
    checkVisible(valueEntry, module, last, span);
    return { types: typeEntry, values: valueEntry };
  }
  if (parent.kind === 'adt' && parent.def.kind === 'enum') {
    const variant = parent.def.variants.find((v) => v.name === last);
    if (variant) {
      return {
        values: { binding: { kind: 'ctor', def: parent.def, variant: variant.index }, visibleWithin: undefined },
      };
    }
  }
  return {};
}

function checkVisible<T>(entry: Entry<T> | undefined, from: Module, name: string, span: Span): void {
  if (!entry || visibleFrom(entry.visibleWithin, from)) return;
  compileError(span, `${name} は非公開です（pub が付いていません）。`);
}

export function visibilityScope(vis: Visibility, owner: Module, span: Span): Module | undefined {
  if (vis === 'pub') return undefined;
  if (vis === 'private') return owner;
  if (typeof vis === 'object') return restrictedScope(vis.in, owner, span);
  const parent = owner.namedModule.parent;
  if (!parent) compileError(span, 'pub(super) には親モジュールが必要です。');
  return parent;
}

/** The module that `pub(in path)` names, which must be the item's module or one around it (E0742). */
// code-gauge-allow functionCognitiveComplexity -- Resolves pub(in path) by Rust rules.
function restrictedScope(path: string[], owner: Module, span: Span): Module {
  const ancestors: Module[] = [];
  for (let module: Module | undefined = owner.namedModule; module; module = module.parent) ancestors.unshift(module);
  let current: Module | undefined;
  for (const [index, name] of path.entries()) {
    if (index === 0 && name === 'crate') current = ancestors[0];
    else if (index === 0 && name === 'self') current = owner.namedModule;
    else if (name === 'super') current = (current ?? owner.namedModule).parent;
    else
      current =
        current && ancestors[ancestors.indexOf(current) + 1]?.name === name
          ? ancestors[ancestors.indexOf(current) + 1]
          : undefined;
    if (!current) break;
  }
  if (!current || !ancestors.includes(current)) {
    compileError(span, `pub(in ${path.join('::')}) には、この項目を囲むモジュールを書いてください。`);
  }
  return current;
}

export function visibleFrom(scope: Module | undefined, from: Module): boolean {
  return !scope || scope.isAncestorOf(from);
}

function narrowerScope(a: Module | undefined, b: Module | undefined): Module | undefined {
  if (!a) return b;
  return visibleFrom(b, a) ? a : b;
}

export function lookupQualifiedValue(module: Module, from: Module, name: string, span: Span): ValueBinding | undefined {
  const entry = ownValue(module, name, span, new Set());
  checkVisible(entry, from, name, span);
  return entry?.binding;
}

/** Resolves a path in the type namespace: a module, a type, or a trait. */
// code-gauge-allow functionCognitiveComplexity -- Follows Rust's name resolution case by case.
// code-gauge-allow functionNcss -- Follows Rust's name resolution case by case.
export function resolveTypePath(segments: string[], module: Module, span: Span): TypeBinding {
  if (segments.length === 0) return { kind: 'mod', module: module.program.root };
  let current: TypeBinding | undefined;
  const [first, ...rest] = segments;
  if (first === 'crate') current = { kind: 'mod', module: module.isStd ? module.program.std : module.program.root };
  else if (first === 'self') current = { kind: 'mod', module: module.namedModule };
  else if (first === 'super') {
    const parent = module.namedModule.parent;
    if (!parent) compileError(span, 'super の先のモジュールがありません。');
    current = { kind: 'mod', module: parent };
  } else {
    current = lookupType(module, first, span);
    if (!current) {
      if (first === 'rand' || first === 'regex' || first === 'serde' || first === 'chrono') {
        compileError(span, `外部のクレート ${first} は、この採点環境では使えません。`);
      }
      compileError(span, `${first} が見つかりません。`);
    }
  }
  for (const segment of rest) {
    if (current.kind !== 'mod') {
      return compileError(span, `${segments.join('::')} が見つかりません。`);
    }
    const owner: Module = current.module;
    if (segment === 'super') {
      const parent = owner.parent;
      if (!parent) compileError(span, 'super の先のモジュールがありません。');
      current = { kind: 'mod', module: parent };
      continue;
    }
    const entry = ownType(owner, segment, span, new Set());
    if (!entry) {
      if (owner.isStd) unavailableStdItem([...owner.path.split('::'), segment], span);
      compileError(span, `${segments.join('::')} が見つかりません。`);
    }
    checkVisible(entry, module, segment, span);
    current = entry.binding;
  }
  return current;
}

export function resolveTraitPath(path: PathAst, scope: TypeScope, self?: Type): TraitRef {
  const binding = resolveTypePath(
    path.segments.map((segment) => segment.name),
    scope.module,
    path.span
  );
  if (binding.kind !== 'trait')
    compileError(path.span, `${path.segments.map((s) => s.name).join('::')} はトレイトではありません。`);
  const def = binding.def;
  const last = path.segments.at(-1);
  const args = traitArguments(def, last?.args ?? [], scope, path.span, self);
  let item: Type | undefined;
  const assocs = new Map<string, Type>();
  for (const assoc of last?.bindings ?? []) {
    const isIterator = ITERATION_TRAITS.has(def.builtin ?? '');
    if (item || assocs.has(assoc.name)) compileError(assoc.span, `関連型 ${assoc.name} が2回指定されています。`);
    if (isIterator && assoc.name === 'Item') {
      item = lowerType(assoc.type, scope);
      continue;
    }
    const owner = allSupertraits([{ trait: def, args }], self).find((ref) => ref.trait.assocTypes.has(assoc.name));
    if (!owner) compileError(assoc.span, `トレイト ${def.name} に関連型 ${assoc.name} がありません（E0220）。`);
    assocs.set(assoc.name, lowerType(assoc.type, scope));
  }
  const ref: TraitRef = item ? { trait: def, args, item } : { trait: def, args };
  return assocs.size > 0 ? { ...ref, assoc: assocs } : ref;
}

function traitArguments(def: TraitDef, written: TypeAst[], scope: TypeScope, span: Span, self?: Type): Type[] {
  const args = defaultTraitArguments(
    def,
    written.map((arg) => lowerType(arg, scope)),
    self
  );
  const omitted = def.params[args.length]?.defaultType;
  if (args.length !== def.params.length && (self || omitted?.kind !== 'param' || omitted.param !== def.self)) {
    compileError(span, `トレイト ${def.name} の型引数の数が合いません（${def.params.length} 個です）。`);
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lowering types

// code-gauge-allow functionNcss -- Follows Rust's name resolution case by case.
export function lowerType(ast: TypeAst, scope: TypeScope): Type {
  switch (ast.kind) {
    case 'path': {
      return lowerPathType(ast.path, scope);
    }
    case 'ref': {
      const target = lowerType(ast.target, scope);
      if (target.kind === 'dyn' && !target.lifetime) target.objectLifetime = 'reference';
      return { kind: 'ref', mutable: ast.mutable, target, lifetime: ast.lifetime };
    }
    case 'tuple': {
      return { kind: 'tuple', elems: ast.elems.map((elem) => lowerType(elem, scope)) };
    }
    case 'array': {
      return lowerArrayType(ast, scope);
    }
    case 'slice': {
      return { kind: 'slice', elem: lowerType(ast.elem, scope) };
    }
    case 'infer': {
      if (!scope.allowInfer) compileError(ast.span, '関数の引数や戻り値の型には _ を書けません。');
      return freshVar();
    }
    case 'never': {
      return NEVER;
    }
    case 'dyn': {
      return lowerDynType(ast, scope);
    }
    case 'impl': {
      return lowerImplType(ast, scope);
    }
    case 'constArg': {
      return lowerConstArg(ast, scope);
    }
    case 'pointer': {
      return scope.module.program.builtinType(ast.mutable ? 'MutPtr' : 'ConstPtr', [lowerType(ast.target, scope)]);
    }
    case 'fnPointer': {
      return {
        kind: 'fn',
        params: ast.params.map((param) => lowerType(param, scope)),
        ret: ast.ret ? lowerType(ast.ret, scope) : UNIT,
        isUnsafe: ast.isUnsafe,
      };
    }
    case 'fnBound': {
      if (scope.implParams === undefined) {
        return compileError(ast.span, '関数ポインタの型（fn(i32) -> i32）は、この採点環境では使えません。');
      }
      return compileError(ast.span, 'Fn(i32) -> i32 は、impl Fn(i32) -> i32 か型引数の境界に書いてください。');
    }
  }
}

/** `impl Trait`: a type parameter of its own in an argument's type, or an opaque type in the return type. */
function lowerImplType(ast: Extract<TypeAst, { kind: 'impl' }>, scope: TypeScope): Type {
  if (scope.implParams) {
    const param = newTypeParam(`impl ${describeBound(ast.bounds[0])}`);
    const type: Type = { kind: 'param', param };
    param.bounds = ast.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type));
    scope.implParams.push(param);
    return type;
  }
  if (!scope.returnOf) return compileError(ast.span, 'impl Trait は、関数の引数と戻り値の型にだけ書けます。');
  const opaque = newOpaque(scope.returnOf.params.map((param) => ({ kind: 'param', param })));
  if (scope.returnOf.trait) opaque.method = scope.returnOf;
  const type: Type = { kind: 'opaque', opaque };
  opaque.bounds = ast.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, type));
  return type;
}

function lowerDynType(ast: Extract<TypeAst, { kind: 'dyn' }>, scope: TypeScope): Type {
  const bounds = ast.bounds.flatMap((bound) => lowerBoundIfTrait(bound, scope, undefined));
  const auto = new Set(
    bounds.filter(({ trait }) => trait.builtin === 'Send' || trait.builtin === 'Sync').map(({ trait }) => trait)
  );
  const principal = bounds.filter(({ trait }) => !auto.has(trait));
  if (principal.length > 1) compileError(ast.span, 'dyn の主トレイトは 1 個だけ書いてください。');
  const trait = principal[0] ?? bounds.find(({ trait }) => trait.builtin === 'Send') ?? bounds[0];
  if (!trait) return compileError(ast.span, 'dyn にはトレイトを書いてください。');
  auto.delete(trait.trait);
  return {
    kind: 'dyn',
    trait,
    autoTraits: [...auto],
    objectLifetime: ast.lifetime === "'static" || (!ast.lifetime && !scope.allowInfer) ? 'static' : undefined,
    lifetime: ast.lifetime,
  };
}

function describeBound(bound: BoundAst): string {
  if (bound.kind === 'fn') return bound.trait;
  if (bound.kind === 'static') return "'static";
  if (bound.kind === 'maybeSized') return '?Sized';
  if (bound.kind === 'lifetime') return bound.name;
  return bound.path.segments.map((segment) => segment.name).join('::');
}

// code-gauge-allow functionNcss -- Follows Rust name resolution case by case.
function lowerPathType(path: PathAst, scope: TypeScope): Type {
  const names = path.segments.map((segment) => segment.name);
  const last = path.segments.at(-1)!;
  const qualified = path.segments[0].qualified;
  if (qualified) return lowerQualifiedPath(path, qualified, scope);
  const owner = names.length === 2 ? scope.params.get(names[0]) : undefined;
  if (owner) return lowerAssocItemPath(path, names, owner, scope);
  if (names.length === 2 && names[0] === 'Self' && scope.selfType) {
    const args = (last.args ?? []).map((arg) => lowerType(arg, scope));
    return assocTypeOf(scope.selfType, names[1], undefined, scope, path.span, args);
  }
  if (last.bindings)
    compileError(last.bindings[0].span, '関連型の指定（Item = ...）は、トレイトの境界にだけ書けます。');
  if (names.length === 1) {
    const local = lowerLocalTypeName(path, scope);
    if (local) return local;
  }
  if (names[0] === 'Self' && names.length > 1) {
    compileError(path.span, 'Self::Item のような関連型は、この採点環境では使えません。');
  }
  const binding = resolveTypePath(names, scope.module, path.span);
  const args = (last.args ?? []).map((arg) => lowerType(arg, scope));
  switch (binding.kind) {
    case 'prim': {
      if (last.args) compileError(path.span, `${last.name} には型引数を書けません。`);
      return binding.type;
    }
    case 'adt': {
      return lowerAdtPath(path, binding.def, args, scope);
    }
    case 'alias': {
      return lowerAliasPath(path, binding, args);
    }
    case 'trait': {
      return compileError(
        path.span,
        `トレイト ${binding.def.name} を型として使うには、dyn ${binding.def.name} と書いてください。`
      );
    }
    case 'mod': {
      return compileError(path.span, `${names.join('::')} はモジュールで、型ではありません。`);
    }
  }
}

function lowerLocalTypeName(path: PathAst, scope: TypeScope): Type | undefined {
  const last = path.segments.at(-1)!;
  const param = scope.params.get(last.name);
  if (param) {
    if (last.args) compileError(path.span, `型引数 ${last.name} には型引数を書けません。`);
    return { kind: 'param', param };
  }
  if (last.name === 'Self') {
    if (!scope.selfType) compileError(path.span, 'Self は、impl やトレイトの中にだけ書けます。');
    return scope.selfType;
  }
  return undefined;
}

function lowerAliasPath(path: PathAst, binding: TypeBinding & { kind: 'alias' }, args: Type[]): Type {
  if (args.length !== binding.params.length) {
    compileError(path.span, `${path.segments.at(-1)!.name} には型引数を ${binding.params.length} 個書いてください。`);
  }
  const named = path.segments.at(-1)?.lifetimes ?? [];
  const lifetimes = new Map(binding.lifetimes.map((name, index) => [name, named[index]]));
  const template = lifetimes.size > 0 ? renameAliasLifetimes(binding.resolve(), lifetimes) : binding.resolve();
  const type = substitute(template, new Map(binding.params.map((param, index) => [param, args[index]])));
  if (type.kind === 'adt' && type.def.builtin === 'Iter' && !type.lifetimes?.length) {
    const inherited = args.flatMap((arg) =>
      arg.kind === 'adt' && arg.def.builtin === 'Iter' ? (arg.lifetimes ?? []) : []
    );
    if (inherited.length > 0) return { ...type, lifetimes: [...new Set(inherited)] };
  }
  return type;
}

function renameAliasLifetimes(type: Type, names: ReadonlyMap<string, string | undefined>): Type {
  const mapped = mapChildren(type, (child) => renameAliasLifetimes(child, names));
  const rename = (name: string): string | undefined => (names.has(name) ? names.get(name) : name);
  if (mapped.kind === 'ref' && mapped.lifetime) return { ...mapped, lifetime: rename(mapped.lifetime) };
  if (mapped.kind === 'adt' && mapped.lifetimes) {
    const lifetimes = mapped.lifetimes.map((name) => rename(name) ?? "'_");
    return { ...mapped, lifetimes };
  }
  return mapped;
}

function lowerAdtPath(path: PathAst, def: AdtDef, written: Type[], scope: TypeScope): Type {
  const last = path.segments.at(-1)!;
  const args = withDefaultArgs(def, written);
  if (args.length !== def.params.length) {
    if (args.length === 0 && scope.inferOmittedArgs)
      return adt(
        def,
        def.params.map(() => freshVar())
      );
    if (def.builtin === 'HashMap' && args.length === 2) return adt(def, args);
    compileError(
      path.span,
      def.params.length === 0
        ? `${def.name} には型引数を書けません。`
        : `${def.name} には型引数を ${def.params.length} 個書いてください（${def.name}<${def.params.map((p) => p.name).join(', ')}>）。`
    );
  }
  return last.lifetimes?.length ? { kind: 'adt', def, args, lifetimes: last.lifetimes } : adt(def, args);
}

/** The type arguments of a type, the omitted ones that have defaults (`struct P<T = i32>`) given those. */
/**
 * Lowers a bound that constrains the type's traits; `?Sized` and lifetime bounds lower to none, as the interpreter
 * lets type parameters be unsized and the borrow checker reads lifetimes from the types.
 */
function lowerBoundIfTrait(bound: BoundAst, scope: TypeScope, self: Type | undefined): TraitRef[] {
  if (bound.kind === 'maybeSized' || bound.kind === 'lifetime') return [];
  return [lowerBound(bound, scope, self)];
}

export function lowerBound(bound: BoundAst, scope: TypeScope, self: Type | undefined): TraitRef {
  if (bound.kind === 'maybeSized' || bound.kind === 'lifetime') {
    return compileError(bound.span, `${describeBound(bound)} は、型引数の境界にだけ書けます。`);
  }
  if (bound.kind === 'static') return { trait: scope.module.program.staticBound, args: [] };
  if (bound.kind === 'fn') {
    const trait = scope.module.program.traitDef(bound.trait);
    return {
      trait,
      args: [],
      fnSig: {
        params: bound.params.map((param) => lowerType(param, scope)),
        ret: bound.ret ? lowerType(bound.ret, scope) : UNIT,
      },
    };
  }
  const ref = resolveTraitPath(bound.path, scope, self);
  const isStd = (ref.trait.module as Module | undefined)?.isStd;
  if (['Fn', 'FnMut', 'FnOnce'].includes(ref.trait.name) && isStd) {
    compileError(
      bound.span,
      `${ref.trait.name} の境界には、引数と戻り値の型を書いてください（${ref.trait.name}(i32) -> i32）。`
    );
  }
  return ref;
}

export function variantOf(def: AdtDef, name: string): VariantDef | undefined {
  return def.variants.find((variant) => variant.name === name);
}
