// code-gauge-allow-file fileNcss 810 -- Follows Rust's name resolution case by case.
import { CompileError } from '../interpreter/diagnostics';
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
import { intoIterItem, iterationBound } from './iterTypes';
import {
  adt,
  type AdtDef,
  BOOL,
  type BuiltinAdt,
  CHAR,
  type ConstDef,
  F32,
  F64,
  type FnDef,
  freshVar,
  type ImplDef,
  INT_NAMES,
  intMax,
  intMin,
  type IntName,
  intType,
  NEVER,
  newOpaque,
  newTypeParam,
  STR,
  substitute,
  type TraitDef,
  type TraitRef,
  type Type,
  type TypeParam,
  UNIT,
  type VariantDef,
} from './types';

export function compileError(span: Span, message: string): never {
  throw new CompileError([{ row: span.row, message }]);
}

export type TypeBinding =
  | { kind: 'adt'; def: AdtDef }
  | { kind: 'trait'; def: TraitDef }
  | { kind: 'mod'; module: Module }
  | { kind: 'alias'; params: TypeParam[]; resolve: () => Type }
  | { kind: 'prim'; type: Type };

export type ValueBinding =
  | { kind: 'fn'; def: FnDef }
  | { kind: 'const'; def: ConstDef }
  /** A tuple struct's or a tuple variant's constructor, or a unit struct or variant. */
  | { kind: 'ctor'; def: AdtDef; variant: number };

interface Entry<T> {
  binding: T;
  isPublic: boolean;
}

/** A use declaration's import of one name, resolved when the name is first looked up. */
interface Import {
  path: string[];
  span: Span;
  isPublic: boolean;
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
  readonly globs: { path: string[]; span: Span; isPublic: boolean }[] = [];
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
    for (let module: Module | undefined = other; module; module = module.parent) {
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
  /** In a function's parameters, `impl Trait` adds an anonymous type parameter here. */
  implParams?: TypeParam[];
  /** In a function's result, `impl Trait` is an opaque type. */
  allowOpaque?: boolean;
  /** Inside a function body, `_` is a type to infer. */
  allowInfer?: boolean;
  /**
   * In a function's signature, `I::Item` of a parameter bounded by `Iterator` or `IntoIterator` without its `Item` adds
   * a type parameter here that the bound sets as `Item`, as if written `I: Iterator<Item = J>`.
   */
  assocParams?: TypeParam[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Collecting items

/** Declares the items of a module, leaving their signatures for {@link lowerSignatures}. */
export class ItemCollector {
  /** Each declared item's work that needs every name declared first. */
  private readonly lowering: (() => void)[] = [];
  /** The self types of impls, which their methods' signatures need first. */
  private readonly implLowering: (() => void)[] = [];
  private readonly bodies: (() => void)[] = [];

  constructor(readonly program: Program) {}

  collectCrate(crate: Crate, module: Module): void {
    this.collectItems(crate.items, module);
  }

  /** Lowers the signatures of every item collected so far. */
  finish(): void {
    for (const lower of this.implLowering.splice(0)) lower();
    for (const lower of this.lowering.splice(0)) lower();
    for (const body of this.bodies.splice(0)) body();
  }

  // code-gauge-allow functionNcss 40 -- Follows Rust's name resolution case by case.
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
          module.types.set(item.name, { binding: { kind: 'mod', module: child }, isPublic: item.vis === 'pub' });
          this.collectItems(item.items, child);
          break;
        }
        case 'use': {
          this.useItem(item, module);
          break;
        }
        case 'typeAlias': {
          let resolved: Type | undefined;
          const params = item.generics.params.map((param) => newTypeParam(param.name));
          const scope: TypeScope = {
            module,
            params: new Map(params.map((param) => [param.name, param])),
            selfType: undefined,
          };
          this.declareType(
            module,
            item.name,
            { kind: 'alias', params, resolve: () => (resolved ??= lowerType(item.type, scope)) },
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
    module.types.set(name, { binding, isPublic: vis === 'pub' });
  }

  private declareValue(module: Module, name: string, binding: ValueBinding, vis: Visibility, span: Span): void {
    if (module.values.has(name)) compileError(span, `${name} という名前が2回宣言されています。`);
    module.values.set(name, { binding, isPublic: vis === 'pub' });
  }

  private structItem(item: StructItem, module: Module): void {
    const def: AdtDef = {
      name: item.name,
      path: module.isStd ? item.name : `${module.path}::${item.name}`,
      kind: 'struct',
      params: item.generics.params.map((param) => newTypeParam(param.name)),
      variants: [],
      derives: new Set(item.attrs.derives.map((derive) => derive.name)),
      span: item.span,
      lifetimeParams: item.generics.lifetimes,
      module,
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
    this.lowering.push(() => {
      const scope = this.adtScope(def, module, item.generics);
      def.variants.push({
        name: item.name,
        index: 0,
        shape: item.shape,
        fields: item.fields.map((field) => ({
          name: field.name,
          type: lowerType(field.type, scope),
          isPublic: field.vis === 'pub',
          span: field.span,
        })),
        discriminant: 0n,
      });
      checkDuplicateFields(item.fields);
    });
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Resolves enum declarations, variants, and discriminants in order.
  // code-gauge-allow functionNcss 41 -- Follows Rust's name resolution case by case.
  private enumItem(item: EnumItem, module: Module): void {
    const def: AdtDef = {
      name: item.name,
      path: module.isStd ? item.name : `${module.path}::${item.name}`,
      kind: 'enum',
      params: item.generics.params.map((param) => newTypeParam(param.name)),
      variants: [],
      derives: new Set(item.attrs.derives.map((derive) => derive.name)),
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
    const deriveDefault = item.attrs.derives.find((derive) => derive.name === 'Default');
    if (deriveDefault) {
      compileError(
        deriveDefault.span,
        '列挙型の #[derive(Default)] には #[default] の属性が要るので、この採点環境では使えません。'
      );
    }
    const names = new Set<string>();
    for (const variant of item.variants) {
      if (names.has(variant.name)) compileError(variant.span, `列挙子 ${variant.name} が2回宣言されています。`);
      names.add(variant.name);
    }
    // Discriminants are known before the bodies, since they are literals in learning programs.
    let next = 0n;
    const discriminants = new Set<bigint>();
    for (const [index, variant] of item.variants.entries()) {
      let discriminant = next;
      if (variant.discriminant) {
        const literal = variant.discriminant;
        if (literal.kind === 'int') discriminant = literal.value;
        else if (literal.kind === 'unary' && literal.op === '-' && literal.operand.kind === 'int') {
          discriminant = -literal.operand.value;
        } else compileError(literal.span, '列挙子の値には、整数のリテラルを書いてください。');
        if (variant.shape !== 'unit' && item.variants.some((v) => v.shape !== 'unit')) {
          // Explicit discriminants on enums with fields need #[repr], which is an attribute.
          compileError(literal.span, 'フィールドを持つ列挙型の列挙子には、値を書けません。');
        }
      }
      if (discriminants.has(discriminant)) {
        compileError(item.span, `列挙型 ${item.name} の判別値 ${discriminant} が2回使われています。`);
      }
      discriminants.add(discriminant);
      def.variants.push({ name: variant.name, index, shape: variant.shape, fields: [], discriminant });
      next = discriminant + 1n;
    }
    this.lowering.push(() => {
      const scope = this.adtScope(def, module, item.generics);
      for (const [index, variant] of item.variants.entries()) {
        def.variants[index].fields = variant.fields.map((field) => ({
          name: field.name,
          type: lowerType(field.type, scope),
          isPublic: true,
          span: field.span,
        }));
        checkDuplicateFields(variant.fields);
      }
    });
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
    for (const [index, param] of generics.params.entries()) {
      def.params[index].bounds = param.bounds.map((bound) =>
        lowerBound(bound, scope, { kind: 'param', param: def.params[index] })
      );
    }
    return scope;
  }

  private traitItem(item: TraitItem, module: Module): void {
    const self = newTypeParam('Self', true);
    const def: TraitDef = {
      name: item.name,
      path: module.isStd && module.path !== 'std::io' ? item.name : `${module.path}::${item.name}`,
      params: item.generics.params.map((param) => newTypeParam(param.name)),
      self,
      methods: new Map(),
      supertraits: [],
      module,
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
    this.lowering.unshift(() => {
      const params = new Map(def.params.map((param) => [param.name, param]));
      const scope: TypeScope = { module, params, selfType };
      def.supertraits = item.supertraits.map((bound) => lowerBound(bound, scope, selfType));
      self.bounds.push(...def.supertraits);
    });
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Follows Rust's name resolution case by case.
  // code-gauge-allow functionNcss 33 -- Follows Rust's name resolution case by case.
  private implItem(item: ImplItem, module: Module): void {
    const impl: ImplDef = {
      params: item.generics.params.map((param) => newTypeParam(param.name)),
      trait: undefined,
      selfType: UNIT,
      methods: new Map(),
      consts: new Map(),
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
    for (const constant of item.consts) impl.consts.set(constant.name, this.constDef(constant, module, impl));
    this.implLowering.push(() => {
      const params = new Map(impl.params.map((param) => [param.name, param]));
      const scope: TypeScope = { module, params, selfType: undefined };
      impl.selfType = lowerType(item.selfType, scope);
      scope.selfType = impl.selfType;
      for (const [index, param] of item.generics.params.entries()) {
        impl.params[index].bounds = param.bounds.map((bound) =>
          lowerBound(bound, scope, { kind: 'param', param: impl.params[index] })
        );
      }
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
      const operators = [
        'Add',
        'Sub',
        'Mul',
        'Div',
        'Rem',
        'Neg',
        'Not',
        'AddAssign',
        'SubAssign',
        'MulAssign',
        'DivAssign',
        'Index',
        'IndexMut',
      ];
      const what = operators.includes(trait.name)
        ? `演算子の多重定義（impl ${trait.name}）`
        : `標準ライブラリのトレイト ${trait.name} の実装`;
      compileError(item.span, `${what}は、この採点環境では使えません。`);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Follows Rust's name resolution case by case.
  private checkTraitImpl(item: ImplItem, impl: ImplDef, trait: TraitDef): void {
    for (const method of item.methods) {
      if (!trait.methods.has(method.name)) {
        compileError(method.span, `メソッド ${method.name} は、トレイト ${trait.name} にありません。`);
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

  private constDef(item: ConstItem, module: Module, impl: ImplDef | undefined): ConstDef {
    const def: ConstDef = { name: item.name, type: UNIT, ast: item, module, impl };
    this.program.consts.push(def);
    this.lowering.push(() => {
      const scope: TypeScope = {
        module,
        params: new Map(impl?.params.map((param) => [param.name, param])),
        selfType: impl?.selfType,
      };
      def.type = lowerType(item.type, scope);
    });
    return def;
  }

  fnDef(item: FnItem, module: Module, impl: ImplDef | undefined, trait: TraitDef | undefined): FnDef {
    const parentParams = impl?.params ?? (trait ? [...trait.params] : []);
    const own = item.generics.params.map((param) => newTypeParam(param.name));
    const def: FnDef = {
      name: item.name,
      params: [...parentParams, ...own],
      parentParamCount: parentParams.length,
      selfMode: item.selfParam?.mode,
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
    const scope: TypeScope = { module, params, selfType, assocParams };
    for (const [index, param] of item.generics.params.entries()) {
      // A method's type parameter may not shadow its impl's.
      if (params.get(param.name) !== own[index] && impl?.params.some((p) => p.name === param.name)) {
        compileError(param.span, `型引数 ${param.name} は、impl の型引数と同じ名前です。`);
      }
      own[index].bounds = param.bounds.map((bound) => lowerBound(bound, scope, { kind: 'param', param: own[index] }));
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
    def.ret = item.ret ? lowerType(item.ret, { ...scope, allowOpaque: true }) : UNIT;
    for (const param of own) assocItem(param, scope);
    def.params.push(...assocParams);
    if (item.name === 'main' && module === this.program.root && !impl && !trait) checkMainSignature(item);
  }

  private useItem(item: UseItem, module: Module): void {
    for (const entry of item.entries) {
      if (entry.glob) {
        module.globs.push({ path: entry.path, span: entry.span, isPublic: item.vis === 'pub' });
        continue;
      }
      const name = entry.alias ?? entry.path.at(-1) ?? '';
      if ((name === 'self' || name === 'super' || name === 'crate') && entry.path.length === 1) {
        compileError(entry.span, `use ${name}; は書けません。`);
      }
      const imported: Import = {
        path: entry.path,
        span: entry.span,
        isPublic: item.vis === 'pub',
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

function checkMainSignature(item: FnItem): void {
  if (item.generics.params.length > 0) compileError(item.span, 'main 関数には型引数を書けません。');
  if (item.params.length > 0) compileError(item.span, 'main 関数には引数を書けません。');
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
    const bounds = predicate.bounds.map((bound) => lowerBound(bound, scope, type));
    if (elsewhere?.(type.param, bounds)) continue;
    type.param.bounds.push(...bounds);
  }
}

/** The traits of the standard library that learning programs implement for their own types. */
const STD_TRAITS_LEARNERS_IMPLEMENT = new Set([
  'Display',
  'Debug',
  'Clone',
  'Copy',
  'PartialEq',
  'Eq',
  'PartialOrd',
  'Ord',
  'Default',
  'From',
  'Error',
  'Hash',
]);

const REQUIRED_STD_METHODS: Record<string, string[]> = {
  Display: ['fmt'],
  Debug: ['fmt'],
  Clone: ['clone'],
  PartialEq: ['eq'],
  PartialOrd: ['partial_cmp'],
  Ord: ['cmp'],
  Default: ['default'],
  From: ['from'],
};

/** A key for an impl's self type in the standard library, naming the natives of its methods (`Vec<_>::push`). */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows Rust's name resolution case by case.
function renderTypeKey(type: TypeAst, generics: Generics): string {
  const render = (t: TypeAst): string => {
    switch (t.kind) {
      case 'path': {
        const last = t.path.segments.at(-1)!;
        const param = generics.params.find((p) => p.name === last.name);
        if (param && t.path.segments.length === 1) {
          const bound = param.bounds[0];
          return bound?.kind === 'trait' ? bound.path.segments.at(-1)!.name : '_';
        }
        return last.args ? `${last.name}<${last.args.map(render).join(', ')}>` : last.name;
      }
      case 'ref': {
        return `&${t.mutable ? 'mut ' : ''}${render(t.target)}`;
      }
      case 'slice': {
        return `[${render(t.elem)}]`;
      }
      case 'array': {
        return `[${render(t.elem)}; N]`;
      }
      case 'tuple': {
        return `(${t.elems.map(render).join(', ')})`;
      }
      default: {
        return t.kind;
      }
    }
  };
  return render(type);
}

const BUILTIN_STRUCTS: Record<string, BuiltinAdt> = {
  String: 'String',
  Vec: 'Vec',
  HashMap: 'HashMap',
  HashSet: 'HashSet',
  BTreeMap: 'BTreeMap',
  BTreeSet: 'BTreeSet',
  VecDeque: 'VecDeque',
  BinaryHeap: 'BinaryHeap',
  Box: 'Box',
  Reverse: 'Reverse',
  Turtle: 'Turtle',
  IterImpl: 'Iter',
  Range: 'Range',
  RangeInclusive: 'RangeInclusive',
  RangeFrom: 'RangeFrom',
  RangeTo: 'RangeTo',
  RangeToInclusive: 'RangeToInclusive',
  RangeFull: 'RangeFull',
  Formatter: 'Formatter',
  Stdout: 'Stdout',
  StdoutLock: 'StdoutLock',
  Stderr: 'Stderr',
  StderrLock: 'StderrLock',
  ParseIntError: 'ParseIntError',
  ParseFloatError: 'ParseFloatError',
  TryFromIntError: 'TryFromIntError',
  Utf8Error: 'Utf8Error',
  Entry: 'Entry',
  CaseIter: 'CaseIter',
  ParseError: 'ParseError',
  Unsigned: 'Unsigned',
  Signed: 'Signed',
  Indexed: 'Indexed',
  TryFromError: 'TryFromError',
  CharTryFromError: 'CharTryFromError',
  TryFromCharError: 'TryFromCharError',
  IterItem: 'IterItem',
  IterShape: 'IterShape',
  IterTarget: 'IterTarget',
  IntoItem: 'IntoItem',
  IntoShape: 'IntoShape',
  ParseBoolError: 'ParseBoolError',
  ParseCharError: 'ParseCharError',
};

const BUILTIN_ENUMS: Record<string, BuiltinAdt> = {
  Option: 'Option',
  Result: 'Result',
  Ordering: 'Ordering',
  Infallible: 'Infallible',
  IntErrorKind: 'IntErrorKind',
};

// ---------------------------------------------------------------------------------------------------------------------
// Name resolution

const EXTERN_CRATES = new Set(['std', 'core', 'alloc']);

/** Looks up a name in a scope's type namespace: its items and imports, the scopes around a block, and the prelude. */
export function lookupType(module: Module, name: string, span: Span): TypeBinding | undefined {
  for (let scope: Module | undefined = module; scope; scope = scope.lexicalParent) {
    const found = ownType(scope, name, span, new Set());
    if (found) return found.binding;
  }
  if (module.isStd) {
    const found = stdIndex(module.program, 'type').get(name);
    if (found) return found as TypeBinding;
  }
  const prim = PRIMITIVES.get(name);
  const preludePath = module.program.prelude.get(name);
  if (preludePath) {
    const found = resolveAbsolute(module.program, preludePath, span, 'type');
    if (found) return found as TypeBinding;
  }
  if (prim) return { kind: 'prim', type: prim };
  if (EXTERN_CRATES.has(name)) return { kind: 'mod', module: module.program.std };
  return undefined;
}

// code-gauge-allow duplicateLines 16 -- Looks up the value namespace as lookupType does the type namespace, whose fallbacks differ.
export function lookupValue(module: Module, name: string, span: Span): ValueBinding | undefined {
  for (let scope: Module | undefined = module; scope; scope = scope.lexicalParent) {
    const found = ownValue(scope, name, span, new Set());
    if (found) return found.binding;
  }
  if (module.isStd) {
    const found = stdIndex(module.program, 'value').get(name);
    if (found) return found as ValueBinding;
  }
  const preludePath = module.program.prelude.get(name);
  if (preludePath) {
    const found = resolveAbsolute(module.program, preludePath, span, 'value');
    if (found) return found as ValueBinding;
  }
  return undefined;
}

/**
 * The value of an integer constant expression, as array lengths take them: literals, constants, integer types' `MIN`
 * and `MAX`, and arithmetic on them. Undefined for other expressions.
 */
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of constant expression.
export function constInteger(expr: Expr, module: Module): bigint | undefined {
  switch (expr.kind) {
    case 'int': {
      return expr.value;
    }
    case 'path': {
      const { segments } = expr.path;
      if (segments.length === 2 && (INT_NAMES as string[]).includes(segments[0].name)) {
        const name = segments[0].name as IntName;
        if (segments[1].name === 'MAX') return intMax(name);
        if (segments[1].name === 'MIN') return intMin(name);
      }
      if (segments.length !== 1) return undefined;
      const binding = lookupValue(module, segments[0].name, expr.span);
      const def = binding?.kind === 'const' ? binding.def : undefined;
      return def?.ast.value ? constInteger(def.ast.value, def.module) : undefined;
    }
    case 'cast': {
      return constInteger(expr.operand, module);
    }
    case 'unary': {
      const operand = constInteger(expr.operand, module);
      return expr.op === '-' && operand !== undefined ? -operand : undefined;
    }
    case 'binary': {
      const left = constInteger(expr.left, module);
      const right = constInteger(expr.right, module);
      return left === undefined || right === undefined ? undefined : integerOperation(expr.op, left, right);
    }
    default: {
      return undefined;
    }
  }
}

function integerOperation(op: string, left: bigint, right: bigint): bigint | undefined {
  const operations: Record<string, () => bigint | undefined> = {
    '+': () => left + right,
    '-': () => left - right,
    '*': () => left * right,
    '/': () => (right === 0n ? undefined : left / right),
    '%': () => (right === 0n ? undefined : left % right),
    '<<': () => left << right,
    '>>': () => left >> right,
    '&': () => left & right,
    '|': () => left | right,
    '^': () => left ^ right,
  };
  return operations[op]?.();
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
// code-gauge-allow functionCognitiveComplexity 24 -- Follows Rust's name resolution case by case.
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

function ownType(module: Module, name: string, span: Span, visiting: Set<Module>): Entry<TypeBinding> | undefined {
  const own = module.types.get(name);
  if (own) return own;
  const imported = module.imports.get(name);
  if (imported) {
    resolveImport(module, imported);
    if (imported.types) return imported.types;
  }
  return fromGlobs(module, name, span, visiting, 'type') as Entry<TypeBinding> | undefined;
}

function ownValue(module: Module, name: string, span: Span, visiting: Set<Module>): Entry<ValueBinding> | undefined {
  const own = module.values.get(name);
  if (own) return own;
  const imported = module.imports.get(name);
  if (imported) {
    resolveImport(module, imported);
    if (imported.values) return imported.values;
  }
  return fromGlobs(module, name, span, visiting, 'value') as Entry<ValueBinding> | undefined;
}

/** The modules resolving their glob imports' paths, which must not look in those same globs. */
const resolvingGlobs = new Set<Module>();

// code-gauge-allow functionCognitiveComplexity 18 -- Follows Rust's name resolution case by case.
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
    for (const glob of module.globs) {
      resolvingGlobs.add(module);
      let target: TypeBinding;
      try {
        target = resolveTypePath(glob.path, module, glob.span);
      } finally {
        resolvingGlobs.delete(module);
      }
      if (target.kind === 'mod') {
        const found =
          ns === 'type' ? ownType(target.module, name, span, visiting) : ownValue(target.module, name, span, visiting);
        if (found?.isPublic || (found && target.module.isAncestorOf(module)))
          return { ...found, isPublic: glob.isPublic };
      } else if (target.kind === 'adt' && target.def.kind === 'enum' && ns === 'value') {
        const variant = target.def.variants.find((v) => v.name === name);
        if (variant)
          return { binding: { kind: 'ctor', def: target.def, variant: variant.index }, isPublic: glob.isPublic };
      }
    }
    return undefined;
  } finally {
    visiting.delete(module);
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
      entry.types = { binding: target, isPublic: entry.isPublic };
    } else if (path.length === 1 && EXTERN_CRATES.has(last)) {
      entry.types = { binding: { kind: 'mod', module: module.program.std }, isPublic: entry.isPublic };
    } else {
      const { types, values } = resolveImportedName(path, module, span);
      if (!types && !values) {
        compileError(span, `use ${path.join('::')} の ${last} が見つかりません。`);
      }
      if (types) entry.types = { binding: types, isPublic: entry.isPublic };
      if (values) entry.values = { binding: values, isPublic: entry.isPublic };
    }
    entry.resolved = true;
  } finally {
    entry.resolving = false;
  }
}

function builtinStruct(module: Module, name: string): BuiltinAdt | undefined {
  if (name !== 'Error') return BUILTIN_STRUCTS[name];
  if (module.name === 'fmt') return 'FmtError';
  return module.path === 'std::io' ? 'IoError' : undefined;
}

function resolveImportedName(
  path: string[],
  module: Module,
  span: Span
): { types?: TypeBinding; values?: ValueBinding } {
  const last = path.at(-1) as string;
  const parent = path.length > 1 ? resolveTypePath(path.slice(0, -1), module, span) : undefined;
  if (!parent) {
    const scope = module.lexicalParent ?? module;
    return { types: lookupType(scope, last, span), values: lookupValue(scope, last, span) };
  }
  if (parent.kind === 'mod') {
    const typeEntry = ownType(parent.module, last, span, new Set());
    const valueEntry = ownValue(parent.module, last, span, new Set());
    if (!typeEntry && !valueEntry && parent.module.isStd)
      checkUnavailableStd([...parent.module.path.split('::'), last], span);
    checkVisible<TypeBinding | ValueBinding>(typeEntry ?? valueEntry, parent.module, module, last, span);
    return { types: typeEntry?.binding, values: valueEntry?.binding };
  }
  if (parent.kind === 'adt' && parent.def.kind === 'enum') {
    const variant = parent.def.variants.find((v) => v.name === last);
    if (variant) return { values: { kind: 'ctor', def: parent.def, variant: variant.index } };
  }
  return {};
}

function checkVisible<T>(entry: Entry<T> | undefined, owner: Module, from: Module, name: string, span: Span): void {
  if (!entry || entry.isPublic || owner.isAncestorOf(from)) return;
  compileError(span, `${name} は非公開です（pub が付いていません）。`);
}

/** Resolves a path in the type namespace: a module, a type, or a trait. */
// code-gauge-allow functionCognitiveComplexity 28 -- Follows Rust's name resolution case by case.
// code-gauge-allow functionNcss 40 -- Follows Rust's name resolution case by case.
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
      if (owner.isStd) checkUnavailableStd([...segments.slice(0, segments.indexOf(segment)), segment], span);
      compileError(span, `${segments.join('::')} が見つかりません。`);
    }
    checkVisible(entry, owner, module, segment, span);
    current = entry.binding;
  }
  return current;
}

/** Rejects the modules of the standard library that touch the outside world or run concurrently (stage D). */
export function checkUnavailableStd(segments: string[], span: Span): void {
  const [, module, name] = segments;
  const unavailable: Record<string, string> = {
    fs: 'ファイルの読み書き（std::fs）',
    net: 'ネットワーク（std::net）',
    thread: 'スレッド（std::thread）',
    sync: 'スレッドの同期（std::sync）',
    env: '環境変数とコマンドラインの引数（std::env）',
    time: '時刻（std::time）',
    rc: 'Rc（std::rc）',
    cell: 'Cell・RefCell（std::cell）',
    future: 'async/await（std::future）',
    task: 'async/await（std::task）',
    any: 'std::any',
    ptr: '生ポインタ（std::ptr）',
    ffi: '外部の関数との連携（std::ffi）',
    os: 'OS の機能（std::os）',
    path: 'ファイルのパス（std::path）',
    alloc: 'メモリの割り当て（std::alloc）',
    arch: 'CPU 固有の命令（std::arch）',
    simd: 'SIMD（std::simd）',
    borrow: 'std::borrow',
    panic: 'std::panic',
    hint: 'std::hint',
  };
  if (module === 'io' && name) {
    compileError(span, '標準入力・ファイルの入出力は、この採点環境では使えません。');
  }
  if (module && unavailable[module]) compileError(span, `${unavailable[module]}は、この採点環境では使えません。`);
  if (module === 'process' && name && name !== 'exit') {
    compileError(span, `外部のプロセス（std::process::${name}）は、この採点環境では使えません。`);
  }
}

/** Resolves a path to a trait, with the type arguments its last segment gives. */
/** A trait with its arguments, where `PartialEq` without one compares with `self`, its default `Rhs`. */
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
  const args = (last?.args ?? []).map((arg) => lowerType(arg, scope));
  if (args.length !== def.params.length) {
    if (def.params.length > 0 && args.length === 0 && def.builtin === 'PartialEq') {
      return { trait: def, args: self ? [self] : [] };
    }
    compileError(path.span, `トレイト ${def.name} の型引数の数が合いません（${def.params.length} 個です）。`);
  }
  let item: Type | undefined;
  for (const assoc of last?.bindings ?? []) {
    const isIterator = def.builtin === 'Iterator' || def.builtin === 'IntoIterator';
    if (!isIterator || assoc.name !== 'Item' || item) {
      compileError(assoc.span, `関連型の指定（${assoc.name} = ...）は、この採点環境では使えません。`);
    }
    item = lowerType(assoc.type, scope);
  }
  return item ? { trait: def, args, item } : { trait: def, args };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lowering types

// code-gauge-allow functionNcss 52 -- Follows Rust's name resolution case by case.
export function lowerType(ast: TypeAst, scope: TypeScope): Type {
  switch (ast.kind) {
    case 'path': {
      return lowerPathType(ast.path, scope);
    }
    case 'ref': {
      return { kind: 'ref', mutable: ast.mutable, target: lowerType(ast.target, scope), lifetime: ast.lifetime };
    }
    case 'tuple': {
      return { kind: 'tuple', elems: ast.elems.map((elem) => lowerType(elem, scope)) };
    }
    case 'array': {
      const length = constInteger(ast.len, scope.module);
      if (length === undefined || length < 0n) {
        compileError(ast.span, '配列の長さには、整数のリテラルか定数の式を書いてください。');
      }
      return { kind: 'array', elem: lowerType(ast.elem, scope), len: Number(length) };
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
      const [bound] = ast.bounds;
      return { kind: 'dyn', trait: lowerBound(bound, scope, undefined) };
    }
    case 'impl': {
      if (scope.implParams) {
        const param = newTypeParam(`impl ${describeBound(ast.bounds[0])}`);
        const type: Type = { kind: 'param', param };
        param.bounds = ast.bounds.map((bound) => lowerBound(bound, scope, type));
        scope.implParams.push(param);
        return type;
      }
      if (scope.allowOpaque) {
        const opaque = newOpaque([]);
        const type: Type = { kind: 'opaque', opaque };
        opaque.bounds = ast.bounds.map((bound) => lowerBound(bound, scope, type));
        if (opaque.bounds.some((bound) => bound.fnSig)) {
          compileError(ast.span, 'クロージャを返す impl Fn は、この採点環境では使えません。');
        }
        return type;
      }
      return compileError(ast.span, 'impl Trait は、関数の引数と戻り値の型にだけ書けます。');
    }
    case 'fnBound': {
      if (scope.implParams === undefined) {
        return compileError(ast.span, '関数ポインタの型（fn(i32) -> i32）は、この採点環境では使えません。');
      }
      return compileError(ast.span, 'Fn(i32) -> i32 は、impl Fn(i32) -> i32 か型引数の境界に書いてください。');
    }
  }
}

/** `I::Item` of a type parameter bounded by `Iterator` or `IntoIterator`. */
function assocItem(param: TypeParam, scope: TypeScope): Type | undefined {
  const paramType: Type = { kind: 'param', param };
  const bound = iterationBound(paramType);
  if (!bound) return undefined;
  if (!bound.item && scope.assocParams) {
    const item = newTypeParam(`${param.name}::Item`);
    scope.assocParams.push(item);
    bound.item = { kind: 'param', param: item };
  }
  return bound.item ?? intoIterItem(paramType);
}

function describeBound(bound: BoundAst): string {
  if (bound.kind === 'fn') return bound.trait;
  return bound.path.segments.map((segment) => segment.name).join('::');
}

function lowerPathType(path: PathAst, scope: TypeScope): Type {
  const names = path.segments.map((segment) => segment.name);
  const last = path.segments.at(-1)!;
  const owner = names.length === 2 ? scope.params.get(names[0]) : undefined;
  if (owner) return lowerAssocItemPath(path, names, owner, scope);
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

function lowerAssocItemPath(path: PathAst, names: string[], owner: TypeParam, scope: TypeScope): Type {
  const last = path.segments.at(-1)!;
  if (last.name !== 'Item' || last.args)
    compileError(path.span, `${names.join('::')} は、この採点環境では使えません。`);
  const item = assocItem(owner, scope);
  if (!item) compileError(path.span, `${owner.name} に関連型 Item がありません（Iterator の境界を書いてください）。`);
  return item;
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
  if (binding.params.length === 0) return binding.resolve();
  if (args.length !== binding.params.length) {
    compileError(path.span, `${path.segments.at(-1)!.name} には型引数を ${binding.params.length} 個書いてください。`);
  }
  return substitute(binding.resolve(), new Map(binding.params.map((param, index) => [param, args[index]])));
}

function lowerAdtPath(path: PathAst, def: AdtDef, args: Type[], scope: TypeScope): Type {
  const last = path.segments.at(-1)!;
  if (args.length !== def.params.length) {
    if (args.length === 0 && scope.allowInfer)
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

/** Lowers a bound on `self`, which closure traits complete with their signature. */
export function lowerBound(bound: BoundAst, scope: TypeScope, self: Type | undefined): TraitRef {
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
  if (['Fn', 'FnMut', 'FnOnce'].includes(ref.trait.name) && (ref.trait.module as Module | undefined)?.isStd) {
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
