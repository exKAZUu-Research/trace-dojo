// code-gauge-allow-file fileNcss -- The renamer resolves every construct of the language against one scope structure.
import { CompileError } from '../interpreter/diagnostics';
import {
  CONS_CON,
  EQUALITY_CLASS,
  FUNCTION_TYPE,
  IMPLICIT_CLASS,
  LIST_TYPE,
  naturalType,
  NIL_CON,
  ONE_TYPE,
  promotedType,
  symbolType,
  tupleCon,
  tupleType,
  TYPE_KIND,
  unboxedSumType,
  unboxedTupleType,
  UNIT_CON,
  UNIT_TYPE,
} from './builtinTypes';
import { hasStarArgument } from './convert';
import { forEachVar } from './dependencies';
import {
  type ClassEntity,
  type ConInfo,
  type FieldInfo,
  type Fixity,
  nextId,
  type TypeEntity,
  type ValueEntity,
} from './entities';
import { compileError, REQUIRED_TYPE_TERM, unsupportedError } from './errors';
import { ExportTableBuilder } from './exportTable';
import type { Extensions } from './extensions';
import type { FeatureGates } from './features';
import { DEFAULT_FIXITY, resolveExprChain, resolvePatChain, resolveTypeChain, sectionOperand } from './fixity';
import { TH_NAME_MODULES } from './library/thNames';
import { type LocalNamespace, LocalScope } from './localScope';
import { emptyExports, type ExportTable, type TypeLike } from './modules';
import { NEWTYPE_STRICT_FIELDS } from './newtypes';
import { libraryPackage } from './packages';
import type {
  Binder,
  LocalVar,
  QBody,
  QClause,
  QCon,
  QDecl,
  QDecls,
  QExpr,
  QFieldExp,
  QGuarded,
  QMatch,
  QPat,
  QQuote,
  QRef,
  QStmt,
  QType,
  QTyVar,
  RAlt,
  RBinder,
  RBindGroup,
  RBinding,
  RClause,
  RConstraint,
  RExpr,
  RFieldBind,
  RGuard,
  RPat,
  RRhs,
  RSigType,
  RStmt,
  RType,
  VarRef,
} from './rast';
import { substituteRType } from './rast';
import { rpatChildren, rpatLocals } from './rastChildren';
import { RecursionBudget } from './recursionBudget';
import { LAMBDA_CASE, MULTI_WAY_IF, QUALIFIED_DO_BIND } from './surfaceForms';
import type {
  Alt,
  ChainItem,
  ConDecl,
  Decl,
  DerivingStrategy,
  Expr,
  FieldBind,
  Guard,
  Import,
  ImportItem,
  Module,
  Name,
  Operator,
  OverlapMode,
  Pat,
  QName,
  QuoteBody,
  Rhs,
  Role,
  SigType,
  Span,
  Stmt,
  TypeEquation,
  TypeExpr,
  TyVarBinder,
} from './syntax';
import { THIS_MODULE } from './syntax';
import { mapPatChildren } from './syntaxChildren';
import { globalNameCode, QuoteBuilder, thString } from './thQuote';
import { checkTypeParams } from './typeNames';
import { type Kind, STAR, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';

export interface RDataDecl {
  entity: TypeEntity;
  /** The type's parameters, or for a data instance, the variables of its types. */
  params: string[];
  /** For a data instance, the types it gives the family's parameters, in terms of `params`. */
  instanceArgs?: RType[];
  /** For a data instance, its types and its variables' kinds once kinds are checked, with or without constructors. */
  instanceHead?: { args: Type[]; kinds: Kind[] };
  paramKinds?: (RType | undefined)[];
  cons: RConDecl[];
  /** The constraints DatatypeContexts puts on the constructors, in terms of `params`. */
  datatypeContext?: RType[];
  deriving: { type: RType; cls?: ClassEntity; strategy?: DerivingStrategy; via?: RType; span: Span }[];
  span: Span;
}

/** A type family with its kind annotations and, for a closed family, its equations. */
export interface RTypeFamily {
  entity: TypeEntity;
  params: string[];
  paramKinds?: (RType | undefined)[];
  resultKind?: RType;
  equations?: RTypeEquation[];
  injective?: number[];
  span: Span;
}

/** An equation of a type family, whose variables are those of its patterns. */
export interface RTypeEquation {
  family: TypeEntity;
  vars: string[];
  patterns: RType[];
  rhs: RType;
  span: Span;
}

export interface RConDecl {
  con: ConInfo;
  fields: RType[];
  /**
   * The type variables the constructor quantifies itself, in order: an existential constructor's `forall`, or every
   * variable of a GADT constructor's signature.
   */
  ownVars?: RBinder[];
  context?: RConstraint[];
  result?: RType;
}

export interface RStandaloneDeriving {
  cls: ClassEntity;
  type: RType;
  context: RConstraint[];
  strategy?: DerivingStrategy;
  via?: RType;
  span: Span;
}

export interface RSynonymDecl {
  entity: TypeEntity;
  params: string[];
  paramKinds?: (RType | undefined)[];
  rhs: RType;
  span: Span;
}

export interface RClassDecl {
  entity: ClassEntity;
  params: string[];
  paramKinds?: (RType | undefined)[];
  supers: RConstraint[];
  methods: { entity: ValueEntity; sig: RSigType }[];
  /** The `default` signatures, which type the default implementations of their methods instead. */
  defaultSigs: { entity: ValueEntity; sig: RSigType }[];
  defaults: RBinding[];
  span: Span;
}

export interface RInstanceDecl {
  cls: ClassEntity;
  type: RType;
  context: RConstraint[];
  bindings: RBinding[];
  overlap?: OverlapMode;
  span: Span;
}

export interface RModule {
  name: string;
  dataDecls: RDataDecl[];
  synonyms: RSynonymDecl[];
  classes: RClassDecl[];
  instances: RInstanceDecl[];
  standaloneDerivings: RStandaloneDeriving[];
  roleAnnotations: { entity: TypeEntity; roles: (Role | undefined)[]; span: Span }[];
  typeFamilies: RTypeFamily[];
  /** The equations of open type families, including the associated types' defaults that instances use. */
  typeInstances: RTypeEquation[];
  /** The standalone kind signatures, `type T :: k`, by the type or class they give the kind of. */
  kindSigs: { entity: TypeEntity | ClassEntity; kind: RType; span: Span }[];
  /** The module's `default` declarations: one for every class, and at most one per class with NamedDefaults. */
  defaultDecls: { cls?: ClassEntity; types: RType[]; span: Span }[];
  values: RBindGroup;
  exports: ExportTable;
  hasExportList: boolean;
  extensions: Extensions;
}

export interface RenameOptions {
  modules: ReadonlyMap<string, ExportTable>;

  unsupportedModule?: (name: string) => string | undefined;

  implicitPrelude: boolean;

  ambient?: readonly ExportTable[];

  weakValues?: ReadonlyMap<string, ValueEntity>;

  weakTypes?: ReadonlyMap<string, TypeEntity>;

  ownShadowsImports?: boolean;

  /** A library value that code the renamer generates refers to, such as `negate` for `-x`. */
  support?: (name: string) => ValueEntity;

  /**
   * For the compilation that runs a splice: the name of the binding that holds the splice's code, which GHC's stage
   * restriction keeps from using the module's own values outside quotes, and the declarations of the splice's group
   * that cannot be compiled before it runs, whose names are in scope while nothing may use them but quotes.
   */
  splice?: { entry: string; pending: Decl[] };
}

/** GHC's stage restriction: a splice's code may run only imported code, while its quotes may name the module's. */
export class StageRestrictionError extends CompileError {}

class Candidates<T> {
  readonly map = new Map<string, T[]>();

  constructor(private readonly identity: (item: T) => unknown = (item) => item) {}

  add(name: string, item: T): void {
    const list = this.map.get(name);
    if (!list) this.map.set(name, [item]);
    else if (!list.some((other) => this.identity(other) === this.identity(item))) list.push(item);
  }

  get(name: string): T[] {
    return this.map.get(name) ?? [];
  }
}

class GlobalScope {
  readonly values = new Candidates<ValueEntity>();
  readonly qualifiedValues = new Map<string, Candidates<ValueEntity>>();
  readonly types = new Candidates<TypeLike>((item) => item.entity);
  readonly qualifiedTypes = new Map<string, Candidates<TypeLike>>();
  readonly moduleAliases = new Set<string>();

  addValue(qualifier: string | undefined, name: string, entity: ValueEntity): void {
    if (qualifier === undefined) {
      this.values.add(name, entity);
      return;
    }
    this.moduleAliases.add(qualifier);
    let candidates = this.qualifiedValues.get(qualifier);
    if (!candidates) {
      candidates = new Candidates();
      this.qualifiedValues.set(qualifier, candidates);
    }
    candidates.add(name, entity);
  }

  addType(qualifier: string | undefined, name: string, entity: TypeLike): void {
    if (qualifier === undefined) {
      this.types.add(name, entity);
      return;
    }
    this.moduleAliases.add(qualifier);
    let candidates = this.qualifiedTypes.get(qualifier);
    if (!candidates) {
      candidates = new Candidates<TypeLike>((item) => item.entity);
      this.qualifiedTypes.set(qualifier, candidates);
    }
    candidates.add(name, entity);
  }
}

let nextLocalId = 0;

export function newLocal(name: string, span: Span): LocalVar {
  return { id: nextLocalId++, name, span };
}

function describeName(name: QName): string {
  return name.qualifier ? `${name.qualifier}.${name.name}` : name.name;
}

function isOperatorName(name: string): boolean {
  return !/^[\p{L}_]/u.test(name);
}

export function renameModule(module: Module, options: RenameOptions): RModule {
  return new Renamer(module, options).run();
}

class Renamer {
  private readonly recursion = new RecursionBudget();
  private readonly scope = new GlobalScope();
  private readonly ownValues = new Map<string, ValueEntity>();
  private readonly importOrigins = new Map<object, Map<string | undefined, Set<string>>>();
  private readonly ownTypes = new Map<string, TypeLike>();
  private globals?: { values: Map<string, ValueEntity[]>; types: Map<string, TypeLike[]> };
  /** The fields DuplicateRecordFields lets share the name of a field of another type. */
  private readonly duplicateFields: ValueEntity[] = [];
  private readonly ownTypeChildren = new Map<TypeLike, ValueEntity[]>();
  private readonly dataDecls: RDataDecl[] = [];
  private readonly synonyms: RSynonymDecl[] = [];
  private readonly classes: RClassDecl[] = [];
  private readonly instances: RInstanceDecl[] = [];
  private readonly standaloneDerivings: RStandaloneDeriving[] = [];
  private readonly dataKindSigs: RModule['kindSigs'] = [];
  private readonly declaredCons = new Map<Decl, ConInfo[]>();
  /** The pattern synonyms, by name, with the names of the functions that match and build their values. */
  private readonly patternSynonyms = new Map<string, PatternSynonymInfo>();
  /** The constructors of the module's `type data` declarations, which are types without a tick or DataKinds. */
  private readonly typeDataCons = new Set<string>();
  /** In quote mode, the variables the quote binds, which its scopes have besides those around the quote. */
  private quoteBinders?: Set<LocalVar>;
  private readonly quoteClassMethods = new Map<LocalVar, Map<string, LocalVar>>();
  private readonly features: FeatureGates<'rename'>;
  /** The entities of the declarations `splice.pending` has, which only quotes may refer to. */
  private readonly pendingEntities = new Set<object>();
  private declaringPending = false;
  /** Whether the renamer is renaming a splice's code outside its quotes, which the stage restriction applies to. */
  private inSpliceCode = false;
  /** Whether names resolve only to be named, as a quote's are, rather than used. */
  private namingOnly = false;
  /** The witnesses of typed quotes, whose code is the module's even inside a splice's code. */
  private readonly witnesses = new WeakSet<Expr>();

  constructor(
    private readonly module: Module,
    private readonly options: RenameOptions
  ) {
    this.features = module.extensions.gates('rename');
    for (const decl of module.decls) {
      if (decl.kind === 'data' && decl.typeData) for (const con of decl.cons) this.typeDataCons.add(con.name.name);
    }
  }

  run(): RModule {
    this.importModules();
    const pending = this.options.splice?.pending ?? [];
    this.declareTypes(this.module.decls);
    this.declareDataInstances(this.module.decls);
    const decls = this.expandBindingWildcards(this.expandPatternSynonyms(this.module.decls), (name) =>
      this.recordFieldNames(name, () => {
        const own = name.qualifier ? undefined : this.ownValues.get(name.name);
        return own?.con ?? this.lookupCon(name);
      })
    );
    const topBindings = this.declareValues(decls);
    this.declarePending(pending);
    this.addOwnToScope();
    this.applyTopFixities([...decls, ...pending]);
    for (const decl of decls) {
      if (decl.kind === 'data') this.renameData(decl);
      else if (decl.kind === 'typeSyn') this.renameSynonym(decl);
      else if (decl.kind === 'class') this.renameClass(decl);
    }
    for (const decl of decls) {
      if (decl.kind === 'instance') this.renameInstance(decl);
      else if (decl.kind === 'standaloneDeriving') this.renameStandaloneDeriving(decl);
    }
    const values = this.renameTopBindings(decls, topBindings);
    return {
      name: this.module.name,
      dataDecls: this.dataDecls,
      synonyms: this.synonyms,
      classes: this.classes,
      instances: this.instances,
      standaloneDerivings: this.standaloneDerivings,
      roleAnnotations: this.renameRoleAnnotations(decls),
      defaultDecls: this.renameDefaultDecls(decls),
      kindSigs: [...this.renameKindSigs(decls), ...this.dataKindSigs],
      ...this.renameFamilies(decls),
      values,
      exports: this.buildExports(),
      hasExportList: this.module.exports !== undefined,
      extensions: this.module.extensions,
    };
  }

  private declarePending(pending: Decl[]): void {
    this.declaringPending = true;
    try {
      this.declareTypes(pending);
      this.declareDataInstances(pending);
      this.declareValues(pending);
    } finally {
      this.declaringPending = false;
    }
  }

  private importModules(): void {
    const imports = [...this.module.imports];
    if (this.options.implicitPrelude && !imports.some((imp) => imp.module === 'Prelude')) {
      imports.unshift({ module: 'Prelude', qualified: false, hiding: false, span: this.module.span });
    }
    for (const ambient of this.options.ambient ?? []) this.importTable(ambient, undefined, true);
    for (const imp of imports) this.importOne(imp);
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch is one form of an import declaration: qualified, aliased, listed, or hiding.
  private importOne(imp: Import): void {
    const exports = this.options.modules.get(imp.module);
    if (!exports) {
      const reason = this.options.unsupportedModule?.(imp.module);
      if (reason !== undefined) throw unsupportedError(imp.span, reason);
      throw unsupportedError(imp.span, `モジュール ${imp.module}`);
    }
    let table: ExportTable = exports;
    if (imp.items) {
      const selected = emptyExports();
      for (const item of imp.items) this.selectImportItem(exports, item, imp, selected);
      if (imp.hiding) {
        table = emptyExports();
        const hiddenValues = new Set(selected.values.values());
        const hiddenTypes = new Set([...selected.types.values()].map((entry) => entry.entity.entity));
        for (const [name, entity] of exports.values) if (!hiddenValues.has(entity)) table.values.set(name, entity);
        for (const [name, entry] of exports.types) {
          if (!hiddenTypes.has(entry.entity.entity)) table.types.set(name, entry);
        }
      } else {
        table = selected;
      }
    }
    const qualifier = imp.alias ?? imp.module;
    this.importTable(table, qualifier, !imp.qualified, imp.module);
  }

  private importTable(table: ExportTable, qualifier: string | undefined, unqualified: boolean, source?: string): void {
    for (const [name, entity] of table.values) {
      this.addImportOrigins(entity, source, qualifier, unqualified);
      if (unqualified) this.scope.addValue(undefined, name, entity);
      if (qualifier !== undefined) this.scope.addValue(qualifier, name, entity);
    }
    for (const [name, entry] of table.types) {
      this.addImportOrigins(entry.entity.entity, source, qualifier, unqualified);
      if (unqualified) this.scope.addType(undefined, name, entry.entity);
      if (qualifier !== undefined) this.scope.addType(qualifier, name, entry.entity);
    }
  }

  private addImportOrigins(
    entity: object,
    source: string | undefined,
    qualifier: string | undefined,
    unqualified: boolean
  ): void {
    if (!source) return;
    if (unqualified) this.addImportOrigin(entity, source, undefined);
    if (qualifier !== undefined) this.addImportOrigin(entity, source, qualifier);
  }

  private addImportOrigin(entity: object, source: string, qualifier: string | undefined): void {
    let scopes = this.importOrigins.get(entity);
    if (!scopes) {
      scopes = new Map();
      this.importOrigins.set(entity, scopes);
    }
    let origins = scopes.get(qualifier);
    if (!origins) {
      origins = new Set();
      scopes.set(qualifier, origins);
    }
    origins.add(source);
  }

  // code-gauge-allow functionCognitiveComplexity -- Import items distinguish values, type children, unsupported entries and hiding.
  // code-gauge-allow functionNcss -- Import selection distinguishes names, children, hiding and unsupported APIs.
  private selectImportItem(exports: ExportTable, item: ImportItem, imp: Import, into: ExportTable): void {
    const { name } = item.name;
    if (item.kind === 'value') {
      const entity = exports.values.get(name);
      if (!entity) {
        if (imp.hiding) return;
        throw compileError(item.name.span, `モジュール ${imp.module} は ${name} を export していません。`);
      }
      if (!imp.hiding && entity.unsupported) throw unsupportedError(item.name.span, entity.unsupported);
      into.values.set(name, entity);
      return;
    }
    const entry = exports.types.get(name);
    const constructor = exports.values.get(name);
    if (imp.hiding && item.children === undefined && constructor) into.values.set(name, constructor);
    if (!entry) {
      if (!imp.hiding && constructor?.unsupported) throw unsupportedError(item.name.span, constructor.unsupported);
      if (imp.hiding) return;
      throw compileError(item.name.span, `モジュール ${imp.module} は ${name} を export していません。`);
    }
    if (!imp.hiding && entry.entity.kind === 'type' && entry.entity.entity.unsupported) {
      throw unsupportedError(item.name.span, entry.entity.entity.unsupported);
    }
    into.types.set(name, { entity: entry.entity, children: [] });
    const associated = associatedTypes(exports, entry.entity);
    const listed = item.children === 'all' ? undefined : (item.children ?? []);
    const selected = listed ? associated.filter(([type]) => listed.some((child) => child.name === type)) : associated;
    for (const [type, typeEntry] of selected) into.types.set(type, typeEntry);
    const children = importChildren(
      listed ? { ...item, children: listed.filter((child) => !selected.some(([type]) => type === child.name)) } : item,
      entry.children,
      imp.hiding
    );
    for (const child of children) {
      // `T(..)` brings in the children this environment lacks too, as GHC's does; a use of one reports it.
      if (!imp.hiding && item.children !== 'all' && child.unsupported) {
        throw unsupportedError(item.name.span, child.unsupported);
      }
      into.values.set(child.name, child);
      (into.types.get(name) as { children: ValueEntity[] }).children.push(child);
    }
  }

  private buildExports(): ExportTable {
    if (!this.module.exports) {
      const table = emptyExports();
      for (const [name, entity] of this.ownValues) table.values.set(name, entity);
      for (const [name, entity] of this.ownTypes) {
        table.types.set(name, { entity, children: this.ownTypeChildren.get(entity) ?? [] });
      }
      return table;
    }
    const builder = new ExportTableBuilder();
    for (const item of this.module.exports) {
      if (item.kind === 'module') {
        this.exportModule(builder, item.name);
        continue;
      }
      if (item.kind === 'value') {
        const entity = this.lookupValue(item.name, false);
        builder.addValue(entity, item.name.span);
        continue;
      }
      const entry = this.lookupType(item.name);
      builder.addType(item.name, entry, this.resolveExportChildren(item, entry));
    }
    return builder.table;
  }

  /** Exports `module M`: what is in scope both unqualified and as `M.x`, or everything the module itself defines. */
  private exportModule(builder: ExportTableBuilder, name: QName): void {
    if (name.name === this.module.name) {
      for (const entity of this.ownValues.values()) builder.addValue(entity, name.span);
      for (const [typeName, entity] of this.ownTypes) {
        builder.addType({ name: typeName, span: name.span }, entity, this.ownTypeChildren.get(entity) ?? []);
      }
      return;
    }
    if (!this.scope.moduleAliases.has(name.name)) {
      throw compileError(name.span, `export の module ${name.name} は、import されていません。`);
    }
    for (const [valueName, entities] of this.scope.qualifiedValues.get(name.name)?.map ?? []) {
      for (const entity of entities) {
        if (this.scope.values.get(valueName).includes(entity)) builder.addValue(entity, name.span);
      }
    }
    for (const [typeName, entries] of this.scope.qualifiedTypes.get(name.name)?.map ?? []) {
      for (const entry of entries) {
        if (this.scope.types.get(typeName).some((other) => other.entity === entry.entity)) {
          builder.addType({ name: typeName, span: name.span }, entry, []);
        }
      }
    }
  }

  private resolveExportChildren(item: ImportItem, parent: TypeLike): ValueEntity[] {
    if (item.children === undefined) return [];
    const available = this.visibleChildrenOf(parent);
    if (item.children === 'all') return available;
    const byName = new Map(available.map((child) => [child.name, child]));
    return item.children.map((child) => {
      chargeTypeWork();
      const found = byName.get(child.name);
      if (
        !found ||
        (child.qualifier && !this.scope.qualifiedValues.get(child.qualifier)?.get(child.name).includes(found))
      ) {
        throw compileError(child.span, `${item.name.name} の中に ${child.name} はありません。`);
      }
      return found;
    });
  }

  private visibleChildrenOf(entry: TypeLike): ValueEntity[] {
    const own = this.ownTypeChildren.get(entry);
    const children =
      own ??
      (entry.kind === 'class'
        ? entry.entity.methods
        : [
            ...entry.entity.cons.map((con) => con.entity),
            ...[...entry.entity.fields.values()].map((field) => field.entity),
          ]);
    return children.filter((child) => {
      chargeTypeWork();
      return own !== undefined || this.importOrigins.has(child) || this.scope.values.get(child.name).includes(child);
    });
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch is one kind of type declaration.
  private declareTypes(decls: Decl[]): void {
    for (const decl of decls) {
      if (decl.kind === 'typeFamily' || decl.kind === 'dataFamily') {
        const entity: TypeEntity = {
          id: nextId(),
          name: decl.name.name,
          module: this.module.name,
          sort: decl.kind === 'typeFamily' ? 'family' : 'data',
          kind: STAR,
          arity: decl.params.length + (decl.kind === 'dataFamily' && decl.kindSig ? kindArity(decl.kindSig) : 0),
          cons: [],
          fields: new Map(),
          span: decl.span,
          ...(decl.kind === 'dataFamily' ? { dataFamily: true } : {}),
          ...(decl.associatedWith ? { associatedClass: decl.associatedWith } : {}),
        };
        this.declareOwnType(decl.name, { kind: 'type', entity });
        this.ownTypeChildren.set(this.ownTypes.get(decl.name.name) as TypeLike, []);
      } else if (decl.kind === 'data' && decl.instanceOf) {
        continue;
      } else if (decl.kind === 'data' || decl.kind === 'typeSyn') {
        const entity: TypeEntity = {
          id: nextId(),
          name: decl.name.name,
          module: this.module.name,
          sort: decl.kind === 'data' ? 'data' : 'synonym',
          kind: STAR,
          arity: decl.params.length + (decl.kind === 'data' && decl.kindSig ? kindArity(decl.kindSig) : 0),
          cons: [],
          fields: new Map(),
          span: decl.span,
        };
        this.declareOwnType(decl.name, { kind: 'type', entity });
        if (decl.kind === 'data') this.declareConstructors(decl, entity);
      } else if (decl.kind === 'class') {
        const entity: ClassEntity = {
          id: nextId(),
          name: decl.name.name,
          module: this.module.name,
          tyvarKind: STAR,
          supers: [],
          methods: [],
          defaults: [],
          span: decl.span,
        };
        if (decl.params.length !== 1) {
          entity.packed = {
            id: nextId(),
            name: decl.name.name,
            module: this.module.name,
            sort: 'prim',
            kind: STAR,
            arity: decl.params.length,
            cons: [],
            fields: new Map(),
            special: 'classArguments',
          };
        }
        entity.fundeps = decl.fundeps.map((fundep) => ({
          from: fundep.from.map((name) => classParamIndex(decl, name)),
          to: fundep.to.map((name) => classParamIndex(decl, name)),
        }));
        const like: TypeLike = { kind: 'class', entity };
        this.declareOwnType(decl.name, like);
        const children: ValueEntity[] = [];
        for (const member of decl.decls) {
          if (member.kind !== 'sig' || member.isDefault) continue;
          for (const name of member.names) {
            const method: ValueEntity = {
              id: nextId(),
              name: name.name,
              module: this.module.name,
              sort: 'method',
              method: { cls: entity, index: entity.methods.length },
              span: name.span,
            };
            entity.methods.push(method);
            entity.defaults.push(undefined);
            this.declareOwnValue(name, method);
            children.push(method);
          }
        }
        this.ownTypeChildren.set(like, children);
      }
    }
  }

  /** Declares the constructors of data instances, which belong to their families. */
  private declareDataInstances(decls: Decl[]): void {
    for (const decl of decls) {
      if (decl.kind !== 'data' || !decl.instanceOf) continue;
      this.declareConstructors(decl, this.familyOf(decl.instanceOf.family, 'data'));
    }
  }

  /** The family an instance names, which must be a type family or a data family as the instance is. */
  private familyOf(name: QName, sort: 'type' | 'data'): TypeEntity {
    const own = name.qualifier ? undefined : this.ownTypes.get(name.name);
    const found = own ?? this.lookupType(name);
    const entity = found.entity as TypeEntity;
    if (found.kind !== 'type' || (sort === 'type' ? entity.sort !== 'family' : !entity.dataFamily)) {
      throw compileError(name.span, `${name.name} は、${sort === 'type' ? '型族' : 'データ族'}ではありません。`);
    }
    return entity;
  }

  private declareOwnType(name: Name, entity: TypeLike): void {
    if (this.ownTypes.has(name.name)) {
      throw compileError(name.span, `${name.name} が重複して宣言されています。`);
    }
    this.ownTypes.set(name.name, entity);
    if (this.declaringPending) this.pendingEntities.add(entity.entity);
  }

  private declareOwnValue(name: Name, entity: ValueEntity): void {
    const existing = this.ownValues.get(name.name);
    // DuplicateRecordFields lets records of different types have fields of the same name.
    if (
      existing?.sort === 'field' &&
      entity.sort === 'field' &&
      existing.field?.type !== entity.field?.type &&
      this.features.allows('duplicateRecordFields')
    ) {
      this.duplicateFields.push(entity);
      return;
    }
    if (this.ownValues.has(name.name)) {
      throw compileError(name.span, `${name.name} が重複して定義されています。`);
    }
    this.ownValues.set(name.name, entity);
    if (this.declaringPending) this.pendingEntities.add(entity);
  }

  private declareConstructors(decl: Extract<Decl, { kind: 'data' }>, type: TypeEntity): void {
    const children: ValueEntity[] = [];
    for (const conDecl of decl.cons) {
      const entity: ValueEntity = {
        id: nextId(),
        name: conDecl.name.name,
        module: this.module.name,
        sort: 'con',
        span: conDecl.name.span,
      };
      const con: ConInfo = {
        entity,
        type,
        name: conDecl.name.name,
        tag: type.cons.length,
        arity: conDecl.fields.length,
        fieldNames: conDecl.fieldNames?.map((fieldName) => fieldName.name),
        isInfix: conDecl.isInfix,
        fieldTypes: [],
        strictFields: decl.newtype ? [...NEWTYPE_STRICT_FIELDS] : conDecl.strictFields,
        span: conDecl.span,
        ...(decl.newtype ? { isNewtype: true } : {}),
      };
      entity.con = con;
      type.cons.push(con);
      this.declareOwnValue(conDecl.name, entity);
      children.push(entity);
      for (const [position, fieldName] of (conDecl.fieldNames ?? []).entries()) {
        let field = type.fields.get(fieldName.name);
        if (!field) {
          const fieldEntity: ValueEntity = {
            id: nextId(),
            name: fieldName.name,
            module: this.module.name,
            sort: 'field',
            span: fieldName.span,
          };
          field = { entity: fieldEntity, type, name: fieldName.name, positions: new Map() };
          fieldEntity.field = field;
          type.fields.set(fieldName.name, field);
          this.declareOwnValue(fieldName, fieldEntity);
          children.push(fieldEntity);
        } else if (field.positions.has(con)) {
          throw compileError(fieldName.span, `フィールド ${fieldName.name} が重複して宣言されています。`);
        }
        field.positions.set(con, position);
      }
    }
    const like = this.ownTypes.get(decl.name.name) as TypeLike;
    this.ownTypeChildren.set(
      like,
      decl.instanceOf ? [...(this.ownTypeChildren.get(like) ?? []), ...children] : children
    );
    this.declaredCons.set(decl, type.cons.slice(type.cons.length - decl.cons.length));
  }

  private declareValues(decls: Decl[]): RawBinding[] {
    const bindings = groupBindings(decls);
    for (const binding of bindings) {
      for (const name of binding.names) {
        const entity: ValueEntity = {
          id: nextId(),
          name: name.name,
          module: this.module.name,
          sort: 'var',
          span: name.span,
        };
        this.declareOwnValue(name, entity);
        binding.entities.push(entity);
      }
    }
    return bindings;
  }

  private addOwnToScope(): void {
    for (const [name, entity] of [
      ...this.ownValues,
      ...this.duplicateFields.map((field) => [field.name, field] as const),
    ]) {
      this.scope.addValue(undefined, name, entity);
      this.scope.addValue(this.module.name, name, entity);
    }
    for (const [name, entity] of this.ownTypes) {
      this.scope.addType(undefined, name, entity);
      this.scope.addType(this.module.name, name, entity);
    }
  }

  private applyTopFixities(decls: Decl[]): void {
    const seen = new Set<string>();
    for (const decl of decls) {
      if (decl.kind === 'fixity') this.applyFixity(decl, seen, (name) => this.ownValues.get(name));
      if (decl.kind !== 'class') continue;
      for (const member of decl.decls) {
        if (member.kind !== 'fixity') continue;
        this.applyFixity(member, seen, (name) => {
          const entity = this.ownValues.get(name);
          return entity?.method?.cls.name === decl.name.name ? entity : undefined;
        });
      }
    }
  }

  /** Gives the operators a fixity declaration names their fixity: a value's, a type's, or both. */
  private applyFixity(
    fixityDecl: Extract<Decl, { kind: 'fixity' }>,
    seen: Set<string>,
    lookup: (name: string) => ValueEntity | undefined
  ): void {
    for (const op of fixityDecl.ops) {
      if (seen.has(op.name)) throw compileError(op.span, `${op.name} の結合性が重複して宣言されています。`);
      seen.add(op.name);
      const entity = lookup(op.name);
      const type = this.ownTypes.get(op.name);
      if (!entity && !type) throw compileError(op.span, `結合性を宣言した ${op.name} の定義がありません。`);
      const fixity = { assoc: fixityDecl.assoc, prec: fixityDecl.prec };
      if (entity) entity.fixity = fixity;
      if (type) type.entity.fixity = fixity;
    }
  }

  private renameData(decl: Extract<Decl, { kind: 'data' }>): void {
    if (decl.instanceOf) {
      this.renameDataInstance(decl, decl.instanceOf);
      return;
    }
    const like = this.ownTypes.get(decl.name.name) as { kind: 'type'; entity: TypeEntity };
    const entity = like.entity;
    const params = checkTypeParams(decl.params);
    if (
      decl.invisibleBinders &&
      !this.module.decls.some((other) => other.kind === 'kindSig' && other.name.name === decl.name.name)
    ) {
      throw compileError(
        decl.span,
        `@ で種類の変数を束縛する ${decl.name.name} には、独立した種類のシグネチャが要ります。`
      );
    }
    const extra = Array.from({ length: entity.arity - decl.params.length }, (_, index) => ` p${index}`);
    const cons = decl.cons.map((conDecl, index): RConDecl => {
      const con = entity.cons[index];
      if (!conDecl.exVars && !conDecl.result) {
        return { con, fields: conDecl.fields.map((field) => this.renameType(field, params)) };
      }
      const own = new Set<string>(conDecl.exVars?.map((binder) => binder.name.name));
      if (conDecl.result && !conDecl.exVars) {
        for (const type of [...(conDecl.context ?? []), ...conDecl.fields, conDecl.result]) collectTypeVars(type, own);
      }
      const vars = new Set([...(conDecl.result ? [] : params), ...own]);
      const ownVars = conDecl.exVars
        ? conDecl.exVars.map((binder) => ({
            name: binder.name.name,
            kind: binder.kind && this.renameKind(binder.kind),
            ...(binder.inferred ? { inferred: true } : {}),
          }))
        : [...own].map((name) => ({ name }));
      return {
        con,
        fields: conDecl.fields.map((field) => this.renameType(field, vars)),
        ownVars,
        context: (conDecl.context ?? []).map((constraint) => this.renameType(constraint, vars)),
        result: conDecl.result && this.renameType(conDecl.result, vars),
      };
    });
    const paramNames = new Set(decl.params.map((param) => param.name));
    const deriving = decl.deriving.map((clause) => ({
      type: this.renameTypeName(clause.cls),
      strategy: clause.strategy,
      via: clause.via && this.renameType(clause.via, paramNames),
      span: clause.span,
    }));
    this.dataDecls.push({
      entity,
      ...(decl.datatypeContext
        ? { datatypeContext: decl.datatypeContext.map((constraint) => this.renameType(constraint, paramNames)) }
        : {}),
      params: [...decl.params.map((param) => param.name), ...extra],
      paramKinds: decl.paramKinds?.map((kind) => kind && this.renameKind(kind)),
      cons,
      deriving,
      span: decl.span,
    });
    if (decl.kindSig) {
      // `data T a :: k` gives the kind after T's written parameters: T's own kind runs through theirs first.
      let kind = this.renameKind(decl.kindSig);
      for (const [index, param] of decl.params.entries().toArray().toReversed()) {
        const written = decl.paramKinds?.[index];
        const from: RType = written ? this.renameKind(written) : { k: 'var', name: ` k${param.name}`, span: decl.span };
        kind = { k: 'fun', from, to: kind, span: decl.span };
      }
      this.dataKindSigs.push({ entity, kind, span: decl.span });
    }
  }

  /**
   * Renames `data instance D t1 t2 = ...`, whose constructors build the family's type at the instance's types and
   * whose variables are those of the instance's types.
   */
  private renameDataInstance(
    decl: Extract<Decl, { kind: 'data' }>,
    instanceOf: NonNullable<Extract<Decl, { kind: 'data' }>['instanceOf']>
  ): void {
    const family = this.familyOf(instanceOf.family, 'data');
    if (instanceOf.patterns.length !== family.arity) {
      throw compileError(decl.span, `データ族 ${family.name} には、型を ${family.arity} 個書いてください。`);
    }
    const vars = new Set<string>();
    for (const pattern of instanceOf.patterns) collectTypeVars(pattern, vars);
    const cons = (this.declaredCons.get(decl) ?? []).map((con, index): RConDecl => ({
      con,
      fields: decl.cons[index].fields.map((field) => this.renameType(field, vars)),
    }));
    const deriving = decl.deriving.map((clause) => ({
      type: this.renameTypeName(clause.cls),
      strategy: clause.strategy,
      via: clause.via && this.renameType(clause.via, vars),
      span: clause.span,
    }));
    this.dataDecls.push({
      entity: family,
      params: [...vars],
      cons,
      deriving,
      span: decl.span,
      instanceArgs: instanceOf.patterns.map((pattern) => this.renameType(pattern, vars)),
    });
  }

  private renameSynonym(decl: Extract<Decl, { kind: 'typeSyn' }>): void {
    const like = this.ownTypes.get(decl.name.name) as { kind: 'type'; entity: TypeEntity };
    const params = checkTypeParams(decl.params);
    this.synonyms.push({
      entity: like.entity,
      params: decl.params.map((param) => param.name),
      paramKinds: decl.paramKinds?.map((kind) => kind && this.renameKind(kind)),
      rhs: this.renameType(decl.type, params),
      span: decl.span,
    });
  }

  // code-gauge-allow functionCognitiveComplexity -- Class declarations combine signatures, defaults, and fixities.
  // code-gauge-allow functionNcss -- Class declarations combine signatures, defaults, and fixities.
  private renameClass(decl: Extract<Decl, { kind: 'class' }>): void {
    const like = this.ownTypes.get(decl.name.name) as { kind: 'class'; entity: ClassEntity };
    const entity = like.entity;
    const params = decl.params.map((param) => param.name);
    const supers = decl.context.map((constraint) => this.renameType(constraint, new Set(params)));
    const methods: RClassDecl['methods'] = [];
    const defaultSigs: RClassDecl['defaultSigs'] = [];
    for (const member of decl.decls) {
      if (member.kind !== 'sig') continue;
      const sig = this.renameSigType(member.sig);
      if (member.isDefault) {
        for (const name of member.names)
          defaultSigs.push({ entity: this.defaultSignatureMethod(entity, name, defaultSigs), sig });
        continue;
      }
      const ambiguousAllowed = this.features.allows('ambiguousClassMethods');
      if (!ambiguousAllowed && params.length > 0 && !params.some((param) => rtypeMentions(sig.type, param))) {
        throw compileError(
          member.span,
          `クラスのメソッド ${member.names[0].name} の型に、クラスの型変数 ${params.join('・')} がありません。`
        );
      }
      for (const name of member.names) {
        const method = entity.methods.find((candidate) => candidate.name === name.name) as ValueEntity;
        methods.push({ entity: method, sig });
      }
    }
    const raw = groupBindings(decl.decls);
    const defaults: RBinding[] = [];
    for (const binding of raw) {
      if (binding.kind !== 'fun') throw compileError(binding.span, 'クラスの中では、パターンで束縛できません。');
      const method = entity.methods.find((candidate) => candidate.name === binding.names[0].name);
      if (!method) {
        throw compileError(
          binding.span,
          `${binding.names[0].name} は、クラス ${entity.name} のメソッドではありません。`
        );
      }
      const renamed = this.renameFunBinding(binding, { kind: 'global', entity: method }, new LocalScope());
      renamed.sig = methods.find((candidate) => candidate.entity === method)?.sig;
      defaults.push(renamed);
    }
    for (const member of decl.decls) {
      if (member.kind === 'fixity') continue;
      if (member.kind === 'sig' || member.kind === 'funClause' || member.kind === 'patBind') continue;
      throw compileError(member.span, 'クラスの中には、メソッドの型と既定の実装だけを書けます。');
    }
    this.classes.push({
      entity,
      params,
      paramKinds: decl.paramKinds?.map((kind) => kind && this.renameKind(kind)),
      supers,
      methods,
      defaultSigs,
      span: decl.span,
      defaults,
    });
  }

  private renameInstance(decl: Extract<Decl, { kind: 'instance' }>): void {
    const cls = this.lookupClass(decl.cls);
    const vars = new Set<string>();
    for (const type of decl.types) collectTypeVars(type, vars);
    const type = this.classArgumentsType(
      cls,
      decl.types.map((argument) => this.renameType(argument, vars)),
      decl.span
    );
    const context = decl.context.map((constraint) => this.renameType(constraint, vars));
    const sigs = this.instanceSignatures(decl.decls);
    const raw = groupBindings(decl.decls).map((binding) => {
      const sig = binding.kind === 'fun' ? sigs.get(binding.names[0].name) : undefined;
      sigs.delete(binding.names[0].name);
      return sig ? withInstanceSignature(binding, sig) : binding;
    });
    for (const [name, sig] of sigs) throw compileError(sig.span, `型シグネチャを書いた ${name} の定義がありません。`);
    const bindings: RBinding[] = [];
    for (const binding of raw) {
      if (binding.kind !== 'fun') throw compileError(binding.span, 'インスタンスの中では、パターンで束縛できません。');
      const method = this.instanceMethod(cls, binding.names[0]);
      bindings.push(this.renameFunBinding(binding, { kind: 'global', entity: method }, new LocalScope()));
    }
    this.instances.push({ cls, type, context, bindings, overlap: decl.overlap, span: decl.span });
  }

  /** The method a class's `default` signature types, which may have only one. */
  private defaultSignatureMethod(entity: ClassEntity, name: Name, defaultSigs: RClassDecl['defaultSigs']): ValueEntity {
    const method = entity.methods.find((candidate) => candidate.name === name.name);
    if (!method) throw compileError(name.span, `${name.name} は、クラス ${entity.name} のメソッドではありません。`);
    if (defaultSigs.some((item) => item.entity === method)) {
      throw compileError(name.span, `${name.name} の default のシグネチャが重複しています。`);
    }
    return method;
  }

  /** The signatures an instance gives its methods, as InstanceSigs allows, by the methods' names. */
  private instanceSignatures(decls: Decl[]): Map<string, Extract<Decl, { kind: 'sig' }>> {
    const sigs = new Map<string, Extract<Decl, { kind: 'sig' }>>();
    for (const member of decls) {
      if (member.kind === 'fixity') throw compileError(member.span, 'インスタンスの中には、結合性を宣言できません。');
      if (member.kind !== 'sig') continue;
      if (!this.features.allows('instanceSigs')) {
        throw compileError(member.span, 'インスタンスの中に型シグネチャを書くには、InstanceSigs の拡張が要ります。');
      }
      for (const name of member.names) {
        if (sigs.has(name.name)) throw compileError(name.span, `${name.name} の型シグネチャが重複しています。`);
        sigs.set(name.name, member);
      }
    }
    return sigs;
  }

  /** The method of a class an instance's binding defines, which must be one the module sees. */
  private instanceMethod(cls: ClassEntity, name: Name): ValueEntity {
    const candidates = [...cls.methods, ...(cls.exportedMethods ?? [])].filter(
      (candidate) => candidate.name === name.name
    );
    if (candidates.length === 0) {
      throw compileError(name.span, `${name.name} は、クラス ${cls.name} のメソッドではありません。`);
    }
    const method = candidates.find(
      (candidate) =>
        this.scope.values.get(candidate.name).includes(candidate) ||
        [...this.scope.qualifiedValues.values()].some((values) => values.get(candidate.name).includes(candidate))
    );
    if (!method) throw compileError(name.span, `${name.name} は、クラス ${cls.name} の見えるメソッドではありません。`);
    if (method.unsupported) throw unsupportedError(name.span, method.unsupported);
    return method;
  }

  private renameFamilies(decls: Decl[]): Pick<RModule, 'typeFamilies' | 'typeInstances'> {
    const typeFamilies: RTypeFamily[] = [];
    const typeInstances: RTypeEquation[] = [];
    const defaults: { cls: string; equation: RTypeEquation; params: string[] }[] = [];
    for (const decl of decls) {
      if (decl.kind === 'typeFamily') {
        const entity = this.familyOf(decl.name, 'type');
        const equations = decl.equations?.map((equation) => this.renameEquation(equation));
        for (const equation of equations ?? []) {
          if (equation.family !== entity) {
            throw compileError(
              equation.span,
              `閉じた型族 ${entity.name} の等式には、${entity.name} を書いてください。`
            );
          }
        }
        typeFamilies.push({
          entity,
          params: decl.params.map((param) => param.name),
          paramKinds: decl.paramKinds?.map((kind) => kind && this.renameKind(kind)),
          resultKind: decl.resultKind && this.renameKind(decl.resultKind),
          equations,
          injective: decl.injective,
          span: decl.span,
        });
        if (equations) entity.closed = true;
      } else if (decl.kind === 'dataFamily') {
        typeFamilies.push({
          entity: this.familyOf(decl.name, 'data'),
          params: decl.params.map((param) => param.name),
          paramKinds: decl.paramKinds?.map((kind) => kind && this.renameKind(kind)),
          resultKind: decl.kindSig && this.renameKind(decl.kindSig),
          span: decl.span,
        });
      } else if (decl.kind === 'typeInstance') {
        const equation = this.renameEquation(decl);
        if (decl.defaultOf) {
          const cls = decls.find(
            (other): other is Extract<Decl, { kind: 'class' }> =>
              other.kind === 'class' && other.name.name === decl.defaultOf
          );
          defaults.push({ cls: decl.defaultOf, equation, params: cls?.params.map((param) => param.name) ?? [] });
        } else typeInstances.push(equation);
      }
    }
    for (const equation of typeInstances) {
      if (equation.family.closed) {
        throw compileError(equation.span, `閉じた型族 ${equation.family.name} には、type instance は書けません。`);
      }
    }
    for (const item of defaults) {
      for (const instance of this.instances) {
        if (instance.cls.name !== item.cls || instance.cls.module !== this.module.name) continue;
        const args = instance.cls.packed ? rtypeArgs(instance.type) : [instance.type];
        const substitution = new Map(item.params.map((param, index) => [param, args[index]]));
        const patterns = item.equation.patterns.map((pattern) => substituteRType(pattern, substitution));
        const key = patterns.map(rtypeKey).join(' ');
        const defined = typeInstances.some(
          (equation) => equation.family === item.equation.family && equation.patterns.map(rtypeKey).join(' ') === key
        );
        if (defined) continue;
        const vars = new Set<string>();
        for (const pattern of patterns) collectRTypeVars(pattern, vars);
        typeInstances.push({
          ...item.equation,
          vars: [...vars],
          patterns,
          rhs: substituteRType(item.equation.rhs, substitution),
          span: instance.span,
        });
      }
    }
    return { typeFamilies, typeInstances };
  }

  private renameEquation(equation: TypeEquation): RTypeEquation {
    const family = this.familyOf(equation.family, 'type');
    const vars = new Set<string>();
    for (const pattern of equation.patterns) collectTypeVars(pattern, vars);
    const rhsVars = new Set<string>();
    collectTypeVars(equation.rhs, rhsVars);
    for (const name of rhsVars) {
      if (!vars.has(name)) throw compileError(equation.span, `型族の等式の右辺の型変数 ${name} が、左辺にありません。`);
    }
    if (equation.patterns.length !== family.arity) {
      throw compileError(equation.span, `型族 ${family.name} には、型を ${family.arity} 個書いてください。`);
    }
    return {
      family,
      vars: [...vars],
      patterns: equation.patterns.map((pattern) => this.renameType(pattern, vars)),
      rhs: this.renameType(equation.rhs, vars),
      span: equation.span,
    };
  }

  private renameKindSigs(decls: Decl[]): RModule['kindSigs'] {
    const seen = new Set<string>();
    return decls.flatMap((decl) => {
      if (decl.kind !== 'kindSig') return [];
      const owner = this.ownTypes.get(decl.name.name);
      if (!owner) throw compileError(decl.span, `種類のシグネチャを書いた ${decl.name.name} の宣言がありません。`);
      if (seen.has(decl.name.name))
        throw compileError(decl.span, `${decl.name.name} の種類のシグネチャが重複しています。`);
      seen.add(decl.name.name);
      return [{ entity: owner.entity, kind: this.renameKind(decl.kindSig), span: decl.span }];
    });
  }

  private renameDefaultDecls(decls: Decl[]): RModule['defaultDecls'] {
    const result: RModule['defaultDecls'] = [];
    for (const decl of decls) {
      if (decl.kind !== 'defaultTypes') continue;
      const cls = decl.cls ? this.lookupClass(decl.cls) : undefined;
      if (result.some((other) => other.cls === cls)) {
        throw compileError(decl.span, 'default 宣言が重複しています。');
      }
      result.push({ cls, types: decl.types.map((type) => this.renameType(type, new Set())), span: decl.span });
    }
    return result;
  }

  /** The type a constraint or instance of a class applies it to: its one argument, or its arguments packed. */
  private classArgumentsType(cls: ClassEntity, args: RType[], span: Span): RType {
    const arity = cls.packed?.arity ?? 1;
    if (args.length !== arity) throw compileError(span, `クラス ${cls.name} には、型を ${arity} 個書いてください。`);
    if (!cls.packed) return args[0];
    let type: RType = { k: 'con', entity: cls.packed, span };
    for (const arg of args) type = { k: 'app', fn: type, arg, span };
    return type;
  }

  private renameStandaloneDeriving(decl: Extract<Decl, { kind: 'standaloneDeriving' }>): void {
    const cls = this.lookupClass(decl.cls);
    const vars = new Set<string>();
    collectTypeVars(decl.type, vars);
    const type = this.renameType(decl.type, vars);
    const context = decl.context.map((constraint) => this.renameType(constraint, vars));
    const via = decl.via && this.renameType(decl.via, vars);
    this.standaloneDerivings.push({ cls, type, context, strategy: decl.strategy, via, span: decl.span });
  }

  /** The roles `type role` annotations give the module's own data types, which the type checker checks. */
  private renameRoleAnnotations(decls: Decl[]): RModule['roleAnnotations'] {
    const seen = new Set<TypeEntity>();
    return decls.flatMap((decl) => {
      if (decl.kind !== 'roleAnnotation') return [];
      const owner = decl.name.qualifier ? undefined : this.ownTypes.get(decl.name.name);
      if (!owner) throw compileError(decl.span, `役割の注釈を書いた型 ${decl.name.name} の宣言がありません。`);
      if (owner.kind !== 'type' || owner.entity.sort !== 'data' || owner.entity.dataFamily) {
        throw compileError(decl.span, `${decl.name.name} には、役割の注釈を書けません。`);
      }
      if (seen.has(owner.entity)) throw compileError(decl.span, `${decl.name.name} の役割の注釈が重複しています。`);
      seen.add(owner.entity);
      if (decl.roles.length !== owner.entity.arity) {
        throw compileError(
          decl.span,
          `${decl.name.name} の役割の注釈には、役割を ${owner.entity.arity} 個書いてください（${decl.roles.length} 個あります）。`
        );
      }
      return [{ entity: owner.entity, roles: decl.roles, span: decl.span }];
    });
  }

  private renameTopBindings(decls: Decl[], raw: RawBinding[]): RBindGroup {
    const sigs = this.collectSigs(decls, raw, (name) => {
      const entity = this.ownValues.get(name);
      return entity?.sort === 'var' ? entity : undefined;
    });
    const scope = new LocalScope();
    const bindings: RBinding[] = raw.map((binding) => {
      if (binding.kind === 'fun') {
        const binder: Binder = { kind: 'global', entity: binding.entities[0] };
        const sig = sigs.get(binding.names[0].name);
        if (binding.names[0].name !== this.options.splice?.entry)
          return this.renameFunBinding(binding, binder, scope, sig);
        this.inSpliceCode = true;
        try {
          return this.renameFunBinding(binding, binder, scope, sig);
        } finally {
          this.inSpliceCode = false;
        }
      }
      const renamed = this.renamePatBinding(binding, scope, (name) => this.ownValues.get(name.name) as ValueEntity);
      renamed.patSigs = patternSignatures(renamed, sigs);
      return renamed;
    });
    return { bindings };
  }

  private collectSigs(decls: Decl[], raw: RawBinding[], exists: (name: string) => unknown): Map<string, RSigType> {
    const bound = new Set(raw.flatMap((binding) => binding.names.map((name) => name.name)));
    const sigs = new Map<string, RSigType>();
    for (const decl of decls) {
      if (decl.kind !== 'sig') continue;
      const sig = this.renameSigType(decl.sig);
      for (const name of decl.names) {
        if (sigs.has(name.name)) throw compileError(name.span, `${name.name} の型シグネチャが重複しています。`);
        if (!bound.has(name.name) || !exists(name.name)) {
          throw compileError(name.span, `型シグネチャを書いた ${name.name} の定義がありません。`);
        }
        sigs.set(name.name, sig);
      }
    }
    return sigs;
  }

  private renameFunBinding(
    raw: RawBinding,
    binder: Binder,
    scope: LocalScope,
    sig?: RSigType
  ): Extract<RBinding, { k: 'fun' }> {
    const clauses: RClause[] = raw.clauses.map((clause) => {
      const clauseScope = new LocalScope(scope);
      const binders = new Map<string, LocalVar>();
      let leading = 0;
      while (clause.args[leading]?.kind === 'ptybinder') leading++;
      const typeBinders = clause.args
        .slice(0, leading)
        .map((pat) => (pat as Extract<Pat, { kind: 'ptybinder' }>).name.name);
      const pats = clause.args.slice(leading).map((pat) => this.renamePat(pat, binders, scope));
      for (const [name, local] of binders) clauseScope.define(name, local);
      return {
        ...(typeBinders.length > 0 ? { typeBinders } : {}),
        pats,
        rhs: this.renameRhs(clause.rhs, clauseScope),
        span: clause.span,
      };
    });
    const renamed: Extract<RBinding, { k: 'fun' }> = { k: 'fun', binder, clauses, span: raw.span };
    if (!sig) return renamed;
    renamed.sig = sig;
    withRequiredTypeArguments(renamed);
    return renamed;
  }

  private renamePatBinding(
    raw: RawBinding,
    scope: LocalScope,
    globalOf?: (name: Name) => ValueEntity
  ): Extract<RBinding, { k: 'pat' }> {
    const clause = raw.clauses[0];
    const binders = new Map<string, LocalVar>();
    const pat = this.renamePat(raw.pattern as Pat, binders, scope);
    const result: Extract<RBinding, { k: 'pat' }> = {
      k: 'pat',
      pat,
      rhs: this.renameRhs(clause.rhs, scope),
      span: raw.span,
      binders: [...binders.values()],
    };
    if (globalOf) result.globals = result.binders.map((local) => globalOf({ name: local.name, span: local.span }));
    return result;
  }

  renameLocalDecls(decls: Decl[], parent: LocalScope): { group: RBindGroup; scope: LocalScope } {
    const declared = this.declareLocalDecls(decls);
    const scope = new LocalScope(parent);
    for (const [name, local] of declared.locals) scope.define(name, local);
    return { group: this.renameDeclaredDecls(declared, scope), scope };
  }

  /** The variables a group of local declarations binds, with the fixities it declares, before its bindings renamed. */
  private declareLocalDecls(sourceDecls: Decl[]): LocalDecls {
    const decls = this.expandBindingWildcards(sourceDecls, (name) =>
      this.recordFieldNames(name, () => this.lookupCon(name))
    );
    for (const decl of decls) {
      if (decl.kind === 'data' || decl.kind === 'typeSyn' || decl.kind === 'class' || decl.kind === 'instance') {
        throw compileError(decl.span, 'data・type・class・instance の宣言は、最上位にだけ書けます。');
      }
    }
    const raw = groupBindings(decls);
    const locals = new Map<string, LocalVar>();
    for (const binding of raw) {
      for (const name of binding.names) {
        if (locals.has(name.name)) throw compileError(name.span, `${name.name} が重複して定義されています。`);
        locals.set(name.name, newLocal(name.name, name.span));
      }
    }
    applyLocalFixities(decls, (name) => locals.get(name));
    return { decls, raw, locals };
  }

  /** The bindings of declared local declarations, renamed in a scope that has their variables. */
  private renameDeclaredDecls({ decls, raw, locals }: LocalDecls, scope: LocalScope): RBindGroup {
    const sigs = this.collectSigs(decls, raw, (name) => locals.get(name));
    const bindings = raw.map((binding): RBinding => {
      if (binding.kind === 'fun') {
        const local = locals.get(binding.names[0].name) as LocalVar;
        return this.renameFunBinding(binding, { kind: 'local', local }, scope, sigs.get(local.name));
      }
      const renamed = this.renamePatBinding(binding, scope);
      // The pattern's variables are the ones the group declared.
      renamed.binders = renamed.binders.map((local) => locals.get(local.name) as LocalVar);
      replacePatLocals(renamed.pat, locals);
      renamed.patSigs = patternSignatures(renamed, sigs);
      return renamed;
    });
    return { bindings };
  }

  private renameRhs(rhs: Rhs, parent: LocalScope): RRhs {
    const { group: where, scope } = this.renameLocalDecls(rhs.where, parent);
    if (rhs.body.kind === 'plain') {
      return { body: { k: 'plain', expr: this.renameExpr(rhs.body.expr, scope) }, where, span: rhs.span };
    }
    const branches = rhs.body.branches.map((branch) => {
      let branchScope = scope;
      const guards: RGuard[] = branch.guards.map((guard) => {
        if (guard.kind === 'bool')
          return { k: 'bool', expr: this.renameExpr(guard.expr, branchScope), span: guard.span };
        if (guard.kind === 'pat') {
          const expr = this.renameExpr(guard.expr, branchScope);
          const binders = new Map<string, LocalVar>();
          const pat = this.renamePat(guard.pat, binders, branchScope);
          branchScope = new LocalScope(branchScope);
          for (const [name, local] of binders) branchScope.define(name, local);
          return { k: 'pat', pat, expr, span: guard.span };
        }
        const local = this.renameLocalDecls(guard.decls, branchScope);
        branchScope = local.scope;
        return { k: 'let', binds: local.group, span: guard.span };
      });
      return { guards, expr: this.renameExpr(branch.expr, branchScope), span: branch.span };
    });
    return { body: { k: 'guarded', branches }, where, span: rhs.span };
  }

  renameExpr(expr: Expr, scope: LocalScope): RExpr {
    if (!this.witnesses.has(expr)) return this.recursion.run(() => this.renameExprCore(expr, scope));
    const saved = this.inSpliceCode;
    this.inSpliceCode = false;
    try {
      return this.recursion.run(() => this.renameExprCore(expr, scope));
    } finally {
      this.inSpliceCode = saved;
    }
  }

  // code-gauge-allow functionNcss -- One short case per expression kind.
  private renameExprCore(expr: Expr, scope: LocalScope): RExpr {
    const { span } = expr;
    switch (expr.kind) {
      case 'var': {
        if (isHoleName(expr.name, scope, (name) => this.valuesNamed(name))) {
          return { k: 'hole', name: expr.name.name, span };
        }
        return {
          k: 'var',
          ref: this.resolveVar(expr.name, scope),
          name: describeName(expr.name),
          span,
          ...(expr.forcing ? { forcing: true } : {}),
        };
      }
      case 'hole': {
        return { k: 'hole', name: expr.name, span };
      }
      case 'thName': {
        return this.renameExpr(this.thNameCode(expr, scope), scope);
      }
      case 'quote': {
        return this.renameExpr(this.quoteCode(expr, scope), scope);
      }
      case 'thSplice': {
        throw compileError(span, 'Template Haskell のスプライスを、ここには書けません。');
      }
      case 'projection': {
        return { k: 'projection', expr: this.renameExpr(expr.expr, scope), field: expr.field, span };
      }
      case 'implicit': {
        return { k: 'implicit', name: expr.name, span };
      }
      case 'implicitLet': {
        const names = new Set<string>();
        for (const bind of expr.binds) {
          if (names.has(bind.name)) throw compileError(bind.span, `暗黙のパラメータ ?${bind.name} が重複しています。`);
          names.add(bind.name);
        }
        return {
          k: 'implicitLet',
          binds: expr.binds.map((bind) => ({
            name: bind.name,
            expr: this.renameExpr(bind.expr, scope),
            span: bind.span,
          })),
          body: this.renameExpr(expr.body, scope),
          span,
        };
      }
      case 'support': {
        const entity = this.supportValue(expr.name, span);
        if (entity.con) return { k: 'con', con: entity.con, span };
        return { k: 'var', ref: { kind: 'global', entity }, name: expr.name, span };
      }
      case 'tyapp': {
        const vars = new Set<string>();
        if (expr.type) collectTypeVars(expr.type, vars);
        return {
          k: 'tyapp',
          expr: this.renameExpr(expr.expr, scope),
          typeArg: expr.type && this.renameType(expr.type, vars),
          required: expr.required,
          span,
        };
      }
      case 'con': {
        const synonym = expr.name.qualifier ? undefined : this.patternSynonyms.get(expr.name.name);
        if (synonym) {
          if (!synonym.builder) {
            throw compileError(
              span,
              `パターンシノニム ${synonym.name} は、照合にだけ使えます（<- で定義されています）。`
            );
          }
          return {
            k: 'var',
            ref: { kind: 'global', entity: this.ownValues.get(synonym.builder) as ValueEntity },
            name: synonym.name,
            span,
          };
        }
        return { k: 'con', con: this.lookupCon(expr.name), span };
      }
      case 'lit': {
        return { k: 'lit', lit: expr.lit, span };
      }
      case 'app': {
        return { k: 'app', fn: this.renameExpr(expr.fn, scope), arg: this.renameExpr(expr.arg, scope), span };
      }
      case 'paren': {
        return this.renameExpr(expr.expr, scope);
      }
      case 'quoteLevel': {
        return this.renameExpr(expr.expr, this.quoteLevelScope(expr, scope));
      }
      case 'chain': {
        return this.renameExpr(
          resolveExprChain(expr.items, span, (op) => this.fixityOf(op, scope)),
          scope
        );
      }
      case 'binop':
      case 'neg': {
        return this.renameOperatorApplication(expr, scope);
      }
      case 'lambda': {
        const binders = new Map<string, LocalVar>();
        const pats = expr.pats.map((pat) => this.renamePat(pat, binders, scope));
        const inner = new LocalScope(scope);
        for (const [name, local] of binders) inner.define(name, local);
        return { k: 'lambda', pats, body: this.renameExpr(expr.body, inner), span };
      }
      case 'let': {
        const local = this.renameLocalDecls(expr.decls, scope);
        return { k: 'let', binds: local.group, body: this.renameExpr(expr.body, local.scope), span };
      }
      case 'if': {
        return {
          k: 'if',
          cond: this.renameExpr(expr.cond, scope),
          ifTrue: this.renameExpr(expr.ifTrue, scope),
          ifFalse: this.renameExpr(expr.ifFalse, scope),
          span,
        };
      }
      case 'case': {
        // A qualified do block's bind needs M.fail only when its pattern can fail.
        const alts =
          expr.what === QUALIFIED_DO_BIND && this.irrefutable(expr.alts[0].pat) ? expr.alts.slice(0, 1) : expr.alts;
        return {
          k: 'case',
          scrutinee: this.renameExpr(expr.scrutinee, scope),
          alts: alts.map((alt) => this.renameAlt(alt, scope)),
          span,
          what: expr.what,
        };
      }
      case 'do': {
        return { k: 'do', stmts: this.renameStmts(expr.stmts, scope, true).stmts, span };
      }
      case 'tuple': {
        return { k: 'tuple', elems: expr.elems.map((elem) => this.renameExpr(elem, scope)), span };
      }
      case 'list': {
        return { k: 'list', elems: expr.elems.map((elem) => this.renameExpr(elem, scope)), span };
      }
      case 'arith': {
        return {
          k: 'arith',
          from: this.renameExpr(expr.from, scope),
          next: expr.next ? this.renameExpr(expr.next, scope) : undefined,
          to: expr.to ? this.renameExpr(expr.to, scope) : undefined,
          span,
        };
      }
      case 'comprehension': {
        return this.renameComprehension(expr, scope);
      }
      case 'leftSection': {
        const left = sectionOperand(expr.op, expr.left, 'infixl', (op) => this.fixityOf(op, scope));
        return { k: 'app', fn: this.renameOperator(expr.op, scope), arg: this.renameExpr(left, scope), span };
      }
      case 'rightSection': {
        if (expr.op.name === '-' && !expr.op.qualifier) {
          // `(- x)` is a negation, not a section.
          return this.renameExpr({ kind: 'neg', expr: expr.right, span }, scope);
        }
        return {
          k: 'rsection',
          op: this.renameOperator(expr.op, scope),
          right: this.renameExpr(
            sectionOperand(expr.op, expr.right, 'infixr', (op) => this.fixityOf(op, scope)),
            scope
          ),
          span,
        };
      }
      case 'typed': {
        return { k: 'typed', expr: this.renameExpr(expr.expr, scope), sig: this.renameSigType(expr.sig), span };
      }
      case 'recordCon': {
        const synonym = expr.con.qualifier ? undefined : this.patternSynonyms.get(expr.con.name);
        if (synonym?.fields) {
          const declared = synonym.fields;
          for (const field of expr.fields) {
            if (!declared.includes(field.field.name)) {
              throw compileError(
                field.span,
                `パターンシノニム ${synonym.name} には、フィールド ${field.field.name} がありません。`
              );
            }
          }
          let result: Expr = { kind: 'con', name: expr.con, span };
          for (const name of declared) {
            const given = expr.fields.find((field) => field.field.name === name);
            // `..` takes a field the construction leaves out from a variable of its name in scope.
            const value: Expr | undefined =
              given?.value ??
              (expr.wildcard && this.wildcardDefined(name, scope)
                ? { kind: 'var', name: { name, span }, span }
                : undefined);
            if (!value)
              throw compileError(span, `パターンシノニム ${synonym.name} のフィールド ${name} がありません。`);
            result = { kind: 'app', fn: result, arg: value, span };
          }
          return this.renameExpr(result, scope);
        }
        const con = this.lookupCon(expr.con);
        const fields = expr.wildcard
          ? [...expr.fields, ...this.wildcardFields(con, expr.fields, expr.wildcard, scope)]
          : expr.fields;
        return { k: 'recordCon', con, fields: this.renameFieldBinds(fields, scope, [con]), span };
      }
      case 'recordUpdate': {
        return {
          k: 'recordUpdate',
          expr: this.renameExpr(expr.expr, scope),
          fields: this.renameFieldBinds(expr.fields, scope, undefined),
          span,
        };
      }
    }
  }

  private renameOperatorApplication(expr: Extract<Expr, { kind: 'binop' | 'neg' }>, scope: LocalScope): RExpr {
    const { span } = expr;
    if (expr.kind === 'neg') {
      const negate = this.options.support?.('negate') ?? this.lookupValue({ name: 'negate', span }, true);
      const fn: RExpr = { k: 'var', ref: { kind: 'global', entity: negate }, name: 'negate', span };
      return { k: 'app', fn, arg: this.renameExpr(expr.expr, scope), span };
    }
    const op = this.renameOperator(expr.op, scope);
    const left = this.renameExpr(expr.left, scope);
    const right = this.renameExpr(expr.right, scope);
    const inner: RExpr = {
      k: 'app',
      fn: op,
      arg: left,
      span: { ...span, endRow: op.span.endRow, endCol: op.span.endCol },
    };
    return { k: 'app', fn: inner, arg: right, span };
  }

  private supportValue(name: string, span: Span): ValueEntity {
    return this.options.support?.(name) ?? this.lookupValue({ name, span }, true);
  }

  /**
   * Replaces pattern synonyms with the functions that implement them: a matcher, `\s -> case s of p -> Just (x, y);
   * _ -> Nothing` (or a `Bool` for a synonym without parameters), and for a synonym that builds values, a builder.
   */
  private expandPatternSynonyms(decls: Decl[]): Decl[] {
    const result: Decl[] = [];
    for (const decl of decls) {
      if (decl.kind === 'patSyn') {
        const name = decl.name.name;
        if (this.patternSynonyms.has(name))
          throw compileError(decl.span, `パターンシノニム ${name} が重複しています。`);
        const matcher = ` match ${name}`;
        const builder = decl.direction === 'unidirectional' ? undefined : ` build ${name}`;
        const fields = decl.fields ? decl.params.map((param) => param.name) : undefined;
        this.patternSynonyms.set(name, { name, arity: decl.params.length, matcher, builder, fields });
        result.push(...patternSynonymFunctions(decl, matcher, builder));
        if (fields) result.push(...patternSynonymSelectors(decl, matcher));
      } else if (decl.kind === 'patSynSig') {
        result.push(...decl.names.flatMap((name) => patternSynonymSignatures(decls, name, decl.sig)));
      } else result.push(decl);
    }
    return result;
  }

  /** Renames a use of a pattern synonym as a view pattern of its matcher. */
  private renameSynonymPattern(
    synonym: PatternSynonymInfo,
    pat: Extract<Pat, { kind: 'pcon' }>,
    binders: Map<string, LocalVar>,
    scope: LocalScope | undefined
  ): RPat {
    const { span } = pat;
    if (pat.args.length !== synonym.arity) {
      throw compileError(span, `パターンシノニム ${synonym.name} には ${synonym.arity} 個の引数が要ります。`);
    }
    const args = pat.args.map((arg) => this.renamePat(arg, binders, scope));
    const conOf = (name: string): ConInfo => this.supportValue(name, span).con as ConInfo;
    const inner: RPat =
      args.length === 0
        ? { k: 'con', con: conOf('True'), args: [], span }
        : {
            k: 'con',
            con: conOf('Just'),
            args: [args.length === 1 ? args[0] : { k: 'con', con: tupleCon(args.length), args, span }],
            span,
          };
    const matcher = this.ownValues.get(synonym.matcher) as ValueEntity;
    return {
      k: 'view',
      expr: { k: 'var', ref: { kind: 'global', entity: matcher }, name: synonym.name, span },
      pat: inner,
      span,
    };
  }

  /**
   * The fields `..` fills in a construction: each one in scope, however qualified, that the construction does not
   * give and whose name a variable in scope has.
   */
  private wildcardFields(con: ConInfo, given: FieldBind[], span: Span, scope: LocalScope): FieldBind[] {
    const named = new Set(given.map((bind) => bind.field.name));
    return this.wildcardFieldNames(con).flatMap((name): FieldBind[] => {
      if (named.has(name) || !this.wildcardDefined(name, scope)) return [];
      return [{ field: { name, span }, value: { kind: 'var', name: { name, span }, span }, span, byWildcard: true }];
    });
  }

  /** The fields of a constructor that `..` takes: those in scope, qualified or not, as GHC has it. */
  private wildcardFieldNames(con: ConInfo): string[] {
    const own = con.entity.module === this.module.name;
    return (con.fieldNames ?? []).filter((name) => own || this.conField(con, name));
  }

  /** A constructor's field of a name, by its identity, if a name in scope, qualified or not, refers to it. */
  private conField(con: ConInfo, name: string): FieldInfo | undefined {
    const tables = [this.scope.values, ...this.scope.qualifiedValues.values()];
    for (const table of tables) {
      const found = table.get(name).find((entity) => entity.sort === 'field' && entity.field?.positions.has(con));
      if (found?.field) return found.field;
    }
    return undefined;
  }

  /** Whether `..` in a construction takes a field from a variable of its name: a local or a top-level one here. */
  private wildcardDefined(name: string, scope: LocalScope): boolean {
    return (
      scope.lookup(name) !== undefined ||
      this.scope.values.get(name).some((entity) => entity.sort === 'var' && entity.module === this.module.name)
    );
  }

  private renameFieldBinds(fields: FieldBind[], scope: LocalScope, cons: ConInfo[] | undefined): RFieldBind[] {
    const seen = new Set<string>();
    const types = cons ? [cons[0].type] : this.updatedTypes(fields);
    return fields.map((fieldBind) => {
      const byWildcard = fieldBind.byWildcard && cons ? this.conField(cons[0], fieldBind.field.name) : undefined;
      const field = byWildcard ?? this.lookupField(fieldBind.field, types);
      if (seen.has(field.name)) throw compileError(fieldBind.span, `フィールド ${field.name} が重複しています。`);
      seen.add(field.name);
      if (cons && !cons.every((con) => field.positions.has(con))) {
        throw compileError(fieldBind.span, `構成子 ${cons[0].name} には、フィールド ${field.name} がありません。`);
      }
      return { field, value: this.renameExpr(fieldBind.value, scope), span: fieldBind.span };
    });
  }

  /**
   * The type an update of fields shared by several types' records updates: the one type that has all of them, or
   * none to choose when no field is shared. GHC reports an update that more than one type fits as ambiguous.
   */
  private updatedTypes(fields: FieldBind[]): TypeEntity[] | undefined {
    const fieldTypes = fields.map((fieldBind) =>
      (fieldBind.field.qualifier
        ? (this.scope.qualifiedValues.get(fieldBind.field.qualifier)?.get(fieldBind.field.name) ?? [])
        : this.scope.values.get(fieldBind.field.name)
      ).flatMap((entity) => (entity.sort === 'field' && entity.field ? [entity.field.type] : []))
    );
    if (fieldTypes.every((types) => types.length <= 1)) return undefined;
    const common = (fieldTypes[0] ?? []).filter((type) => fieldTypes.every((types) => types.includes(type)));
    if (common.length !== 1) {
      const shared = fields.find((_, index) => fieldTypes[index].length > 1) as FieldBind;
      throw compileError(
        shared.span,
        `フィールド ${shared.field.name} を持つ型が複数あるので、どの型のレコードを更新するか決まりません。`
      );
    }
    return common;
  }

  private renameOperator(op: Operator, scope: LocalScope): RExpr {
    if (op.isConstructor) return { k: 'con', con: this.lookupCon(op), span: op.span };
    return { k: 'var', ref: this.resolveVar(op, scope), name: describeName(op), span: op.span };
  }

  private renameAlt(alt: Alt, scope: LocalScope): RAlt {
    const binders = new Map<string, LocalVar>();
    const pat = this.renamePat(alt.pat, binders, scope);
    const inner = new LocalScope(scope);
    for (const [name, local] of binders) inner.define(name, local);
    return { pat, rhs: this.renameRhs(alt.rhs, inner), span: alt.span };
  }

  /**
   * A comprehension: a list comprehension, or under MonadComprehensions a `do` block in any monad. Its `then`
   * qualifiers and parallel branches lower on the renamed qualifiers, whose variables are the locals they bind.
   */
  private renameComprehension(expr: Extract<Expr, { kind: 'comprehension' }>, scope: LocalScope): RExpr {
    const { span } = expr;
    const monad = this.features.allows('monadComprehensions');
    const branches = [expr.quals, ...(expr.parallel ?? [])].map((quals) => this.renameQualifiers(quals, scope, monad));
    if (branches.length === 1) {
      const [branch] = branches;
      return this.comprehensionOf(branch.stmts, this.renameExpr(expr.expr, branch.scope), monad, span);
    }
    // `[e | qs1 | qs2]` is `[e | (vs1, vs2) <- zip [vs1 | qs1] [vs2 | qs2]]`, with `mzip` in a monad, where each `vs`
    // is the tuple of the variables its branch binds.
    const names = new Set<string>();
    const tuples = branches.map((branch) => {
      const locals = visibleLocals(branch.stmts, branch.scope);
      for (const local of locals) {
        if (names.has(local.name))
          throw compileError(local.span, `並列の内包表記の中で ${local.name} が重複しています。`);
        names.add(local.name);
      }
      const source = this.comprehensionOf(branch.stmts, tupleExpr(locals, span), monad, span);
      return { source, ...freshTuple(locals, span) };
    });
    const outer = withLocals(
      scope,
      tuples.flatMap((tuple) => tuple.fresh)
    );
    const zip = this.supportExpr(monad ? 'mzip' : 'zip', span);
    let { source, pat } = tuples.at(-1) as (typeof tuples)[number];
    for (const tuple of tuples.slice(0, -1).toReversed()) {
      source = applyExpr(zip, [tuple.source, source], span);
      pat = { k: 'con', con: tupleCon(2), args: [tuple.pat, pat], span };
    }
    const result = this.renameExpr(expr.expr, outer);
    return this.comprehensionOf([{ k: 'bind', pat, expr: source, span }], result, monad, span);
  }

  /** A comprehension of renamed qualifiers, whose boolean guards are `guard`s in a monad. */
  private comprehensionOf(quals: RStmt[], result: RExpr, monad: boolean, span: Span): RExpr {
    if (!monad) return { k: 'comp', expr: result, quals, span };
    const stmts = quals.map((qual): RStmt =>
      qual.k === 'exp'
        ? { ...qual, expr: applyExpr(this.supportExpr('guard', qual.span), [qual.expr], qual.span) }
        : qual
    );
    stmts.push({ k: 'exp', expr: applyExpr(this.supportExpr('return', span), [result], span), span });
    return { k: 'do', stmts, span };
  }

  /**
   * A branch's qualifiers. `qs, then f, rs` is `vs <- f [vs | qs], rs`, where `vs` are the variables `qs` bind; `then
   * f by e` passes `f` the function `\vs -> e`, and `then group` rebinds each of them to the list of its values in a
   * group.
   */
  private renameQualifiers(quals: Stmt[], parent: LocalScope, monad: boolean): { stmts: RStmt[]; scope: LocalScope } {
    let stmts: RStmt[] = [];
    let scope = parent;
    for (const qual of quals) {
      if (qual.kind === 'rec') throw compileError(qual.span, 'rec は、do の中にだけ書けます。');
      if (qual.kind !== 'transform') {
        const renamed = this.renameStmt(qual, scope);
        stmts.push(renamed.stmt);
        scope = renamed.scope;
        continue;
      }
      const transformed = this.transformedQualifiers(qual, stmts, scope, parent, monad);
      stmts = [transformed.stmt];
      scope = transformed.scope;
    }
    return { stmts, scope };
  }

  /** The qualifiers before a `then` and the `then` as the one bind of the variables they bind. */
  private transformedQualifiers(
    qual: Extract<Stmt, { kind: 'transform' }>,
    stmts: RStmt[],
    scope: LocalScope,
    parent: LocalScope,
    monad: boolean
  ): { stmt: RStmt; scope: LocalScope } {
    const { span } = qual;
    const locals = visibleLocals(stmts, scope);
    let source = this.comprehensionOf(stmts, tupleExpr(locals, span), monad, span);
    const fn = this.renameExpr(qual.fn, parent);
    if (qual.by) {
      const key = freshTuple(locals, span);
      const by: RExpr = {
        k: 'lambda',
        pats: [key.pat],
        body: this.renameExpr(qual.by, withLocals(parent, key.fresh)),
        span,
      };
      source = applyExpr(fn, [by, source], span);
    } else source = applyExpr(fn, [source], span);
    if (qual.group) source = this.regrouped(locals, source, span);
    const bound = freshTuple(locals, span);
    return { stmt: { k: 'bind', pat: bound.pat, expr: source, span }, scope: withLocals(parent, bound.fresh) };
  }

  /** `map (\g -> (map (\vs -> v1) g, ...)) groups`: each group of tuples as the tuple of its variables' lists. */
  private regrouped(locals: LocalVar[], groups: RExpr, span: Span): RExpr {
    const group = newLocal(' group', span);
    const map = this.supportExpr('map', span);
    const columns = locals.map((_, index) => {
      const column = freshTuple(locals, span);
      const select: RExpr = { k: 'lambda', pats: [column.pat], body: localExpr(column.fresh[index], span), span };
      return applyExpr(map, [select, localExpr(group, span)], span);
    });
    const body = columns.length === 1 ? columns[0] : tupleOfExprs(columns, span);
    const regroup: RExpr = { k: 'lambda', pats: [{ k: 'var', local: group, span }], body, span };
    return applyExpr(map, [regroup, groups], span);
  }

  /**
   * A block's statements. A `rec` block's statements see all the variables they bind, and it lowers, as GHC's does,
   * to `vs <- mfix (\~vs -> do { ss; return vs })`; an `mdo`'s is split into the smallest such segments first.
   */
  private renameStmts(source: Stmt[], parent: LocalScope, isDo: boolean): { stmts: RStmt[]; scope: LocalScope } {
    let scope = parent;
    const stmts: RStmt[] = [];
    const blocks: RecursiveBlock[] = [];
    for (const [index, stmt] of source.entries()) {
      if (isDo && index === source.length - 1 && stmt.kind !== 'exp') {
        throw compileError(
          stmt.span,
          `do の最後の文は、式にしてください（${stmt.kind === 'let' ? 'let' : '<-'} で終われません）。`
        );
      }
      if (stmt.kind === 'rec') {
        const block = this.renameRecursiveBlock(stmt, scope);
        blocks.push(block);
        stmts.push(...block.stmts);
        scope = block.scope;
        continue;
      }
      if (stmt.kind === 'transform') throw compileError(stmt.span, 'then は、リストの内包表記の中にだけ書けます。');
      const renamed = this.renameStmt(stmt, scope);
      stmts.push(renamed.stmt);
      scope = renamed.scope;
    }
    let lowered = stmts;
    for (const block of blocks) lowered = this.lowerRecursiveBlock(block, lowered);
    return { stmts: lowered, scope };
  }

  private renameStmt(
    stmt: Extract<Stmt, { kind: 'bind' | 'let' | 'exp' }>,
    scope: LocalScope
  ): { stmt: RStmt; scope: LocalScope } {
    const { span } = stmt;
    switch (stmt.kind) {
      case 'exp': {
        return { stmt: { k: 'exp', expr: this.renameExpr(stmt.expr, scope), span }, scope };
      }
      case 'bind': {
        const expr = this.renameExpr(stmt.expr, scope);
        const binders = new Map<string, LocalVar>();
        const pat = this.renamePat(stmt.pat, binders, scope);
        return { stmt: { k: 'bind', pat, expr, span }, scope: withLocals(scope, binders.values()) };
      }
      case 'let': {
        const local = this.renameLocalDecls(stmt.decls, scope);
        return { stmt: { k: 'let', binds: local.group, span }, scope: local.scope };
      }
    }
  }

  /**
   * The statements of a `rec` block, renamed where every variable they bind is in scope, as the statements after it
   * are: their patterns and declarations first, then their expressions.
   */
  private renameRecursiveBlock(block: Extract<Stmt, { kind: 'rec' }>, parent: LocalScope): RecursiveBlock {
    const heads = block.stmts.map((stmt) => this.recursiveHead(stmt, parent));
    const scope = new LocalScope(parent);
    const owners = new Map<LocalVar, number>();
    for (const [index, head] of heads.entries()) {
      for (const local of head.locals) {
        if (scope.vars.has(local.name)) {
          throw compileError(local.span, `rec と mdo の中では、${local.name} を一度だけ束縛してください。`);
        }
        scope.define(local.name, local);
        owners.set(local, index);
      }
    }
    const stmts = heads.map((head): RStmt => {
      const { span } = head.stmt;
      if (head.k === 'let') return { k: 'let', binds: this.renameDeclaredDecls(head.declared, scope), span };
      const expr = this.renameExpr(head.stmt.expr, scope);
      return head.k === 'bind' ? { k: 'bind', pat: head.pat, expr, span } : { k: 'exp', expr, span };
    });
    return { stmts, owners, segmented: block.segmented ?? false, scope, span: block.span };
  }

  /** What a statement of a `rec` block binds, renamed before the expressions of the block. */
  private recursiveHead(stmt: Stmt, parent: LocalScope): RecursiveHead {
    switch (stmt.kind) {
      case 'bind': {
        const binders = new Map<string, LocalVar>();
        return { k: 'bind', stmt, pat: this.renamePat(stmt.pat, binders, parent), locals: [...binders.values()] };
      }
      case 'let': {
        const declared = this.declareLocalDecls(stmt.decls);
        return { k: 'let', stmt, declared, locals: [...declared.locals.values()] };
      }
      case 'exp': {
        return { k: 'exp', stmt, locals: [] };
      }
      case 'rec': {
        throw compileError(stmt.span, 'rec の中に rec は書けません。');
      }
      case 'transform': {
        throw compileError(stmt.span, 'then は、リストの内包表記の中にだけ書けます。');
      }
    }
  }

  /**
   * The statements of a `do` with a renamed `rec` block among them replaced by its segments, each the bind `vs <- mfix
   * (\~vs' -> do { ss; return vs })`. In an `mdo`, a statement that uses a variable a later statement binds (or a bind
   * its own) shares a segment with every statement up to that one, and overlapping segments join, as GHC segments
   * them; the other statements stay as they are. A `rec` block is one segment.
   */
  private lowerRecursiveBlock(block: RecursiveBlock, stmts: RStmt[]): RStmt[] {
    const start = stmts.indexOf(block.stmts[0]);
    const count = block.stmts.length;
    const reach = block.stmts.map((stmt, index) => {
      let last = -1;
      forEachVar([stmt], (node) => {
        const owner = node.ref.kind === 'local' ? block.owners.get(node.ref.local) : undefined;
        if (owner !== undefined && isForward(owner, index, stmt)) last = Math.max(last, owner);
      });
      return last;
    });
    const result = stmts.slice(0, start);
    const after = stmts.slice(start + count);
    for (let index = 0; index < count; index++) {
      if (block.segmented && reach[index] < index) {
        result.push(block.stmts[index]);
        continue;
      }
      let end = block.segmented ? reach[index] : count - 1;
      for (let inner = index; inner <= end; inner++) end = Math.max(end, reach[inner]);
      const later = [...block.stmts.slice(end + 1), ...after];
      result.push(this.recursiveBind(block, index, end, later));
      index = end;
    }
    result.push(...after);
    return result;
  }

  /**
   * A segment of a `rec` block as its `mfix` bind: its statements' uses of the variables it binds at or after them
   * refer to the lambda's, and the statements after it use the bind's.
   */
  private recursiveBind(block: RecursiveBlock, first: number, last: number, after: RStmt[]): RStmt {
    const { span } = block;
    const segment = block.stmts.slice(first, last + 1);
    const locals = [...block.owners].flatMap(([local, owner]) => (owner >= first && owner <= last ? [local] : []));
    const lambda = freshTuple(locals, span);
    const bound = freshTuple(locals, span);
    for (const [index, stmt] of segment.entries()) {
      redirectLocals([stmt], locals, (position) =>
        isForward(block.owners.get(locals[position]) as number, first + index, stmt)
          ? lambda.fresh[position]
          : undefined
      );
    }
    redirectLocals(after, locals, (position) => bound.fresh[position]);
    const result = applyExpr(this.supportExpr('return', span), [tupleExpr(locals, span)], span);
    const body: RExpr = { k: 'do', stmts: [...segment, { k: 'exp', expr: result, span }], span };
    const fn: RExpr = { k: 'lambda', pats: [{ k: 'lazy', pat: lambda.pat, span }], body, span };
    return { k: 'bind', pat: bound.pat, expr: applyExpr(this.supportExpr('mfix', span), [fn], span), span };
  }

  private supportExpr(name: string, span: Span): RExpr {
    const entity = this.supportValue(name, span);
    return entity.con ? { k: 'con', con: entity.con, span } : { k: 'var', ref: { kind: 'global', entity }, name, span };
  }

  /** The fixity of an operator in scope: a local's, or in quote mode, one a quote refers to outside it. */
  private fixityOf(op: Operator, scope: LocalScope | undefined): Fixity {
    if (!op.qualifier) {
      const local = scope?.lookup(op.name, op.isConstructor ? 'con' : 'value');
      if (local) return local.fixity ?? DEFAULT_FIXITY;
    }
    if (this.quoteBinders) return this.quoteFixity(op);
    if (op.isConstructor && !op.qualifier && this.patternSynonyms.has(op.name)) return DEFAULT_FIXITY;
    const entity = op.isConstructor ? this.lookupCon(op).entity : this.lookupValue(op, true);
    return entity.fixity ?? DEFAULT_FIXITY;
  }

  /** @param scope The scope of the expressions in view patterns, besides the variables the pattern binds before them. */
  renamePat(pat: Pat, binders: Map<string, LocalVar>, scope?: LocalScope): RPat {
    return this.recursion.run(() => ({ ...this.renamePatCore(pat, binders, scope), span: pat.span, surface: pat }));
  }

  // code-gauge-allow functionNcss -- One short case per pattern kind.
  private renamePatCore(pat: Pat, binders: Map<string, LocalVar>, scope: LocalScope | undefined): RPat {
    const { span } = pat;
    switch (pat.kind) {
      case 'pbang': {
        return { k: 'bang', pat: this.renamePat(pat.pat, binders, scope), span };
      }
      case 'ptybinder': {
        throw unsupportedError(span, '関数の最初の引数以外での @ による型の束縛');
      }
      case 'psig': {
        const vars = new Set<string>();
        collectTypeVars(pat.type, vars);
        return {
          k: 'sig',
          pat: this.renamePat(pat.pat, binders, scope),
          sigType: this.renameType(pat.type, vars),
          span,
        };
      }
      case 'plazy': {
        return { k: 'lazy', pat: this.renamePat(pat.pat, binders, scope), span };
      }
      case 'pview': {
        const viewScope = new LocalScope(scope);
        for (const [name, local] of binders) viewScope.define(name, local);
        const expr = this.renameExpr(pat.expr, viewScope);
        return { k: 'view', expr, pat: this.renamePat(pat.pat, binders, scope), span };
      }
      case 'por': {
        const alts = pat.alts.map((alt) => {
          const own = new Map<string, LocalVar>();
          const renamed = this.renamePat(alt, own, scope);
          const bound = [...own.values()][0];
          if (bound) throw compileError(bound.span, 'or パターンの中では、変数を束縛できません。');
          return renamed;
        });
        return { k: 'or', alts, span };
      }
      case 'pvar': {
        return { k: 'var', local: this.bindPatVar(pat.name, binders), span };
      }
      case 'pwild': {
        return { k: 'wild', span };
      }
      case 'plit': {
        if (pat.negative && pat.lit.kind !== 'int' && pat.lit.kind !== 'frac') {
          throw compileError(span, '- は、数のリテラルの前にだけ書けます。');
        }
        return { k: 'lit', lit: pat.lit, negative: pat.negative, span };
      }
      case 'pcon': {
        const synonym = pat.con.qualifier ? undefined : this.patternSynonyms.get(pat.con.name);
        if (synonym) return this.renameSynonymPattern(synonym, pat, binders, scope);
        const con = this.lookupCon(pat.con);
        if (pat.args.length !== con.arity) {
          throw compileError(
            span,
            `構成子 ${con.name} には ${con.arity} 個の引数が要りますが、パターンには ${pat.args.length} 個あります。`
          );
        }
        return { k: 'con', con, args: pat.args.map((arg) => this.renamePat(arg, binders, scope)), span };
      }
      case 'ptuple': {
        const con = tupleCon(pat.elems.length);
        return { k: 'con', con, args: pat.elems.map((elem) => this.renamePat(elem, binders, scope)), span };
      }
      case 'plist': {
        let result: RPat = { k: 'con', con: NIL_CON, args: [], span };
        const elems = pat.elems.map((elem) => this.renamePat(elem, binders, scope));
        for (const elem of elems.toReversed()) result = { k: 'con', con: CONS_CON, args: [elem, result], span };
        return result;
      }
      case 'pas': {
        const local = this.bindPatVar(pat.name, binders);
        return { k: 'as', local, pat: this.renamePat(pat.pat, binders, scope), span };
      }
      case 'precord': {
        return this.renameRecordPattern(pat, binders, scope);
      }
      case 'pchain': {
        return this.renamePat(
          resolvePatChain(pat.items, span, (op) => this.fixityOf(op, scope)),
          binders,
          scope
        );
      }
    }
  }

  /** The fields a record pattern's `..` binds: those of a record pattern synonym, or of the constructor. */
  private recordFieldNames(name: QName, con: () => ConInfo): readonly string[] {
    const synonym = name.qualifier ? undefined : this.patternSynonyms.get(name.name);
    return synonym?.fields ?? this.wildcardFieldNames(con());
  }

  /**
   * Replaces the `..` of the record patterns of pattern bindings with the fields they bind, whose names the bindings
   * must declare before their patterns are renamed.
   */
  private expandBindingWildcards(decls: Decl[], resolve: (name: QName) => readonly string[]): Decl[] {
    return decls.map((decl) =>
      decl.kind === 'patBind' ? { ...decl, pat: expandRecordWildcards(decl.pat, resolve) } : decl
    );
  }

  private renameRecordPattern(
    source: Extract<Pat, { kind: 'precord' }>,
    binders: Map<string, LocalVar>,
    scope: LocalScope | undefined
  ): RPat {
    const synonym = source.con.qualifier ? undefined : this.patternSynonyms.get(source.con.name);
    if (synonym?.fields) return this.renameSynonymRecordPattern(synonym, synonym.fields, source, binders, scope);
    const pat = expandRecordWildcards(source, (name) =>
      this.recordFieldNames(name, () => this.lookupCon(name))
    ) as typeof source;
    const { span } = pat;
    const con = this.lookupCon(pat.con);
    const args: RPat[] = Array.from({ length: con.arity }, () => ({ k: 'wild', span }) as RPat);
    const seen = new Set<string>();
    const order: number[] = [];
    for (const fieldPat of pat.fields) {
      const field = fieldPat.byWildcard ? undefined : this.lookupField(fieldPat.field, [con.type]);
      const name = field?.name ?? fieldPat.field.name;
      const position = field ? field.positions.get(con) : (con.fieldNames ?? []).indexOf(name);
      if (position === undefined) {
        throw compileError(fieldPat.span, `構成子 ${con.name} には、フィールド ${name} がありません。`);
      }
      if (seen.has(name)) throw compileError(fieldPat.span, `フィールド ${name} が重複しています。`);
      seen.add(name);
      args[position] = this.renamePat(fieldPat.pat, binders, scope);
      order.push(position);
    }
    return { k: 'con', con, args, order, span };
  }

  /** A record pattern of a record pattern synonym, as the use of the synonym with its fields in order. */
  private renameSynonymRecordPattern(
    synonym: PatternSynonymInfo,
    fields: string[],
    source: Extract<Pat, { kind: 'precord' }>,
    binders: Map<string, LocalVar>,
    scope: LocalScope | undefined
  ): RPat {
    for (const field of source.fields) {
      if (!fields.includes(field.field.name)) {
        throw compileError(
          field.span,
          `パターンシノニム ${synonym.name} には、フィールド ${field.field.name} がありません。`
        );
      }
    }
    const { span } = source;
    const args = fields.map((name): Pat => {
      const given = source.fields.find((field) => field.field.name === name);
      if (given) return given.pat;
      return source.wildcard ? { kind: 'pvar', name: { name, span }, span } : { kind: 'pwild', span };
    });
    return this.renameSynonymPattern(synonym, { kind: 'pcon', con: source.con, args, span }, binders, scope);
  }

  /** The variable a pattern binds: a new one, or the one a declaration group `declared` for its name. */
  private bindPatVar(name: Name, binders: Map<string, LocalVar>, declared?: ReadonlyMap<string, LocalVar>): LocalVar {
    const local = declared?.get(name.name);
    if (local) return local;
    if (binders.has(name.name)) throw compileError(name.span, `パターンの中で ${name.name} が重複しています。`);
    const created = this.newBinder(name.name, name.span);
    binders.set(name.name, created);
    return created;
  }

  renameSigType(sig: SigType): RSigType {
    const vars = new Set<string>();
    collectTypeVars(sig.type, vars);
    for (const constraint of sig.context) collectTypeVars(constraint, vars);
    const forall = sig.forall?.map((binder) => {
      vars.add(binder.name.name);
      return {
        name: binder.name.name,
        kind: binder.kind && this.renameKind(binder.kind),
        inferred: binder.inferred,
        required: binder.required,
      };
    });
    return {
      context: sig.context.map((constraint) => this.renameType(constraint, vars)),
      type: this.renameType(sig.type, vars),
      span: sig.span,
      ...(forall ? { forall } : {}),
    };
  }

  /** Renames a kind, whose variables need no binder. */
  renameKind(kind: TypeExpr): RType {
    const vars = new Set<string>();
    collectTypeVars(kind, vars);
    return this.renameType(kind, vars);
  }

  renameType(type: TypeExpr, vars: ReadonlySet<string>): RType {
    const { span } = type;
    switch (type.kind) {
      case 'tvar': {
        if (!vars.has(type.name)) throw compileError(span, `型変数 ${type.name} がスコープにありません。`);
        return { k: 'var', name: type.name, span };
      }
      case 'tcon': {
        if (type.star && !this.features.allows('starIsType')) {
          throw compileError(span, '* を種類として使うには、StarIsType の拡張が要ります。');
        }
        return this.renameTypeName(type.name);
      }
      case 'tapp': {
        const product = this.starProduct(type);
        if (product) return this.renameType({ kind: 'tchain', items: product, span }, vars);
        return { k: 'app', fn: this.renameType(type.fn, vars), arg: this.renameType(type.arg, vars), span };
      }
      case 'tfun': {
        const multiplicity: RType | undefined =
          type.multiplicity?.kind === 'one'
            ? { k: 'con', entity: ONE_TYPE, span }
            : type.multiplicity?.kind === 'var'
              ? this.renameType({ kind: 'tvar', name: type.multiplicity.name, span: type.multiplicity.span }, vars)
              : undefined;
        return {
          k: 'fun',
          from: this.renameType(type.from, vars),
          to: this.renameType(type.to, vars),
          ...(multiplicity ? { multiplicity } : {}),
          span,
        };
      }
      case 'tlist': {
        return { k: 'app', fn: { k: 'con', entity: LIST_TYPE, span }, arg: this.renameType(type.elem, vars), span };
      }
      case 'ttuple': {
        return { k: 'tuple', elems: type.elems.map((elem) => this.renameType(elem, vars)), span };
      }
      case 'tsplice': {
        throw compileError(span, 'Template Haskell のスプライスを、ここには書けません。');
      }
      case 'tkinded': {
        return { k: 'kinded', type: this.renameType(type.type, vars), kind: this.renameKind(type.kindSig), span };
      }
      case 'tpromoted': {
        return { k: 'con', entity: promotedType(this.lookupCon(type.name)), span };
      }
      case 'tpromotedList': {
        let result: RType = { k: 'con', entity: promotedType(NIL_CON), span };
        for (const elem of type.elems.toReversed()) {
          result = {
            k: 'app',
            fn: {
              k: 'app',
              fn: { k: 'con', entity: promotedType(CONS_CON), span },
              arg: this.renameType(elem, vars),
              span,
            },
            arg: result,
            span,
          };
        }
        return result;
      }
      case 'tpromotedTuple': {
        let result: RType = { k: 'con', entity: promotedType(tupleCon(type.elems.length)), span };
        for (const elem of type.elems) result = { k: 'app', fn: result, arg: this.renameType(elem, vars), span };
        return result;
      }
      case 'tkindapp': {
        return { k: 'kindapp', type: this.renameType(type.type, vars), kind: this.renameKind(type.kindArg), span };
      }
      case 'timplicit': {
        return {
          k: 'app',
          fn: {
            k: 'app',
            fn: { k: 'class', entity: IMPLICIT_CLASS, span },
            arg: { k: 'con', entity: symbolType(type.name), span },
            span,
          },
          arg: this.renameType(type.type, vars),
          span,
        };
      }
      case 'tlit': {
        return {
          k: 'con',
          entity: typeof type.value === 'string' ? symbolType(type.value) : naturalType(type.value),
          span,
        };
      }
      case 'tchain': {
        // A product the grammar read as an application joins the chain, so that fixities order it with the rest.
        const items = type.items.flatMap((item) =>
          item.kind === 'operand' ? (this.starProduct(item.value) ?? [item]) : [item]
        );
        return this.renameType(
          resolveTypeChain(items, span, (op) => this.typeFixityOf(op)),
          vars
        );
      }
      case 'tforall': {
        const inner = new Set([...vars, ...type.binders.map((binder) => binder.name.name)]);
        return {
          k: 'forall',
          binders: type.binders.map((binder) => ({
            name: binder.name.name,
            kind: binder.kind && this.renameKind(binder.kind),
            inferred: binder.inferred,
          })),
          context: type.context.map((constraint) => this.renameType(constraint, inner)),
          body: this.renameType(type.body, inner),
          span,
        };
      }
    }
  }

  /** Whether a pattern always matches: variables, lazy patterns, and constructors of types with only one. */
  private irrefutable(pat: Pat): boolean {
    switch (pat.kind) {
      case 'pvar':
      case 'pwild':
      case 'plazy': {
        return true;
      }
      case 'pbang':
      case 'psig':
      case 'pas': {
        return this.irrefutable(pat.pat);
      }
      case 'ptuple': {
        return pat.elems.every((elem) => this.irrefutable(elem));
      }
      case 'pcon':
      case 'precord': {
        if (!pat.con.qualifier && this.patternSynonyms.has(pat.con.name)) return false;
        if (this.lookupCon(pat.con).type.cons.length !== 1) return false;
        const args = pat.kind === 'pcon' ? pat.args : pat.fields.map((field) => field.pat);
        return args.every((arg) => this.irrefutable(arg));
      }
      default: {
        return false;
      }
    }
  }

  /**
   * The code a quote builds: its body renamed in quote mode, then built into calls of the library's functions that
   * build its tree. A typed quote also has its expression as the module's code has it, which gives the quote its type.
   */
  private quoteCode(expr: Extract<Expr, { kind: 'quote' }>, scope: LocalScope): Expr {
    const { span } = expr;
    const built = new QuoteBuilder(span).build(this.renameQuote(expr.body, scope));
    if (!expr.witness) return built;
    this.witnesses.add(expr.witness);
    const typer: Expr = { kind: 'lambda', pats: [{ kind: 'pwild', span }], body: expr.witness, span };
    return thCall(span, 'typedQuote', typer, built);
  }

  /**
   * Renames a quote in quote mode, in the scope it is written in: the same scopes, lookups, fixities, and binder
   * collection as the module's code, with each name annotated with its stage, a binder of the quote, a variable
   * around it (which the tree holds lifted), a global name, or an unbound one. Quote mode applies none of the
   * syntax's desugarings, so the tree keeps what the quote wrote.
   */
  private renameQuote(body: QuoteBody, scope: LocalScope): QQuote {
    const saved = this.quoteBinders;
    this.quoteBinders = new Set();
    try {
      switch (body.kind) {
        case 'exp': {
          return { k: 'exp', expr: this.quoteExpr(body.expr, scope) };
        }
        case 'pat': {
          return { k: 'pat', pat: this.quotePat(body.pat, new Map(), scope) };
        }
        case 'type': {
          return { k: 'type', type: this.quoteType(body.type, scope) };
        }
        case 'decs': {
          return { k: 'decs', decls: this.quoteDeclGroup(body.decls, scope).decls };
        }
      }
    } finally {
      this.quoteBinders = saved;
    }
  }

  /** A new local, which in quote mode is a binder of the quote, of a namespace. */
  private newBinder(name: string, span: Span, namespace: LocalNamespace = 'value'): LocalVar {
    const local = newLocal(name, span);
    this.quoteBinders?.add(local);
    local.namespace = namespace;
    return local;
  }

  /**
   * The scope of a splice's code inside quotes, where the quotes' binders are names that only quotes inside the
   * splice may use, as their binders at the same level.
   */
  private quoteLevelScope(expr: Extract<Expr, { kind: 'quoteLevel' }>, scope: LocalScope): LocalScope {
    const inner = new LocalScope(scope);
    for (const { name, namespace, nameVariable } of expr.binders) {
      inner.define(name, { ...newLocal(name, expr.span), quoteLevelName: nameVariable }, namespace);
    }
    return inner;
  }

  private quoteValueRef(name: QName, scope: LocalScope, namespace: 'var' | 'value', required = false): QRef {
    const local = name.qualifier ? undefined : scope.lookup(name.name);
    if (local) {
      return this.quoteBinders?.has(local) || local.quoteLevelName !== undefined
        ? { k: 'bound', local }
        : { k: 'outer', name: name.name };
    }
    return this.quoteGlobal(namespace, name, required);
  }

  /** A record field's label, which names a field (one a quoted declaration declares, or a global one), never a variable. */
  private quoteFieldRef(name: QName, scope: LocalScope): QRef {
    const local = name.qualifier ? undefined : scope.lookup(name.name, 'field');
    return local ? { k: 'bound', local } : this.quoteGlobal('value', name, true);
  }

  private quoteConRef(name: QName, scope: LocalScope, required: boolean): QRef {
    const local = name.qualifier ? undefined : scope.lookup(name.name, 'con');
    return local ? { k: 'bound', local } : this.quoteGlobal('con', name, required);
  }

  private quoteTypeRef(name: QName, scope: LocalScope): QRef {
    const local = name.qualifier ? undefined : scope.lookup(name.name, 'type');
    return local ? { k: 'bound', local } : this.quoteGlobal('type', name, true);
  }

  private quoteTyVarRef(name: string, scope: LocalScope): QRef {
    const local = scope.lookup(name, 'tyVar');
    return local ? { k: 'bound', local } : { k: 'unbound', name };
  }

  private unsupportedInQuote(span: Span, what: string): Error {
    return unsupportedError(span, `Template Haskell のクォートの中の${what}`);
  }

  // code-gauge-allow functionNcss -- One short case per expression kind a quote may hold.
  private quoteExpr(expr: Expr, scope: LocalScope): QExpr {
    switch (expr.kind) {
      case 'var': {
        return { k: 'var', ref: this.quoteValueRef(expr.name, scope, 'var') };
      }
      case 'con': {
        return { k: 'con', ref: this.quoteConRef(expr.name, scope, false) };
      }
      case 'lit': {
        return { k: 'lit', lit: expr.lit };
      }
      case 'app': {
        return { k: 'app', fn: this.quoteExpr(expr.fn, scope), arg: this.quoteExpr(expr.arg, scope) };
      }
      case 'paren': {
        return this.quoteExpr(expr.expr, scope);
      }
      case 'chain': {
        return this.quoteExpr(
          resolveExprChain(expr.items, expr.span, (op) => this.fixityOf(op, scope)),
          scope
        );
      }
      case 'binop': {
        const op = this.quoteOperator(expr.op, scope);
        return { k: 'infix', left: this.quoteExpr(expr.left, scope), op, right: this.quoteExpr(expr.right, scope) };
      }
      case 'neg': {
        const entity = this.supportValue('negate', expr.span);
        const negate: QExpr = {
          k: 'var',
          ref: this.globalRef('v', this.thModule('v', entity), entity.name),
        };
        return { k: 'app', fn: negate, arg: this.quoteExpr(expr.expr, scope) };
      }
      case 'leftSection': {
        return { k: 'infix', left: this.quoteExpr(expr.left, scope), op: this.quoteOperator(expr.op, scope) };
      }
      case 'rightSection': {
        return { k: 'infix', op: this.quoteOperator(expr.op, scope), right: this.quoteExpr(expr.right, scope) };
      }
      case 'lambda': {
        const sugar = this.quoteLambdaSugar(expr, scope);
        if (sugar) return sugar;
        const binders = new Map<string, LocalVar>();
        const pats = expr.pats.map((pat) => this.quotePat(pat, binders, scope));
        return { k: 'lambda', pats, body: this.quoteExpr(expr.body, withLocals(scope, binders.values())) };
      }
      case 'let': {
        const group = this.quoteDeclGroup(expr.decls, scope);
        return { k: 'let', decls: group.decls, body: this.quoteExpr(expr.body, group.scope) };
      }
      case 'if': {
        return {
          k: 'if',
          cond: this.quoteExpr(expr.cond, scope),
          ifTrue: this.quoteExpr(expr.ifTrue, scope),
          ifFalse: this.quoteExpr(expr.ifFalse, scope),
        };
      }
      case 'case': {
        return this.quoteCase(expr, scope);
      }
      case 'do': {
        return { k: 'do', stmts: this.quoteStmts(expr.stmts, scope).stmts };
      }
      case 'tuple':
      case 'list': {
        if (expr.kind === 'list' && expr.elems.length === 0) {
          return { k: 'con', ref: this.quoteConRef({ name: '[]', span: expr.span }, scope, true) };
        }
        return { k: expr.kind, elems: expr.elems.map((elem) => this.quoteExpr(elem, scope)) };
      }
      default: {
        return this.quoteOtherExpr(expr, scope);
      }
    }
  }

  private quoteOtherExpr(expr: Expr, scope: LocalScope): QExpr {
    switch (expr.kind) {
      case 'arith': {
        return {
          k: 'arith',
          from: this.quoteExpr(expr.from, scope),
          next: expr.next && this.quoteExpr(expr.next, scope),
          to: expr.to && this.quoteExpr(expr.to, scope),
        };
      }
      case 'comprehension': {
        if (expr.parallel) throw this.unsupportedInQuote(expr.span, '並列の内包表記');
        const final: Stmt = { kind: 'exp', expr: expr.expr, span: expr.span };
        return { k: 'comp', stmts: this.quoteStmts([...expr.quals, final], scope).stmts };
      }
      case 'typed': {
        return { k: 'sig', expr: this.quoteExpr(expr.expr, scope), type: this.quoteSigType(expr.sig, scope) };
      }
      case 'recordCon': {
        if (expr.wildcard) throw this.unsupportedInQuote(expr.span, 'レコードのワイルドカード');
        return {
          k: 'recordCon',
          con: this.quoteConRef(expr.con, scope, true),
          fields: this.quoteFieldExps(expr.fields, scope),
        };
      }
      case 'recordUpdate': {
        return {
          k: 'recordUpdate',
          expr: this.quoteExpr(expr.expr, scope),
          fields: this.quoteFieldExps(expr.fields, scope),
        };
      }
      case 'tyapp': {
        if (!expr.type) throw this.unsupportedInQuote(expr.span, '型の適用 @_');
        return { k: 'tyapp', expr: this.quoteExpr(expr.expr, scope), type: this.quoteType(expr.type, scope) };
      }
      case 'thSplice': {
        return { k: 'splice', code: expr.expr };
      }
      default: {
        throw this.unsupportedInQuote(expr.span, 'この式');
      }
    }
  }

  private quoteOperator(op: Operator, scope: LocalScope): QExpr {
    return op.isConstructor
      ? { k: 'con', ref: this.quoteConRef(op, scope, false) }
      : { k: 'var', ref: this.quoteValueRef(op, scope, 'var') };
  }

  private quoteFieldExps(fields: FieldBind[], scope: LocalScope): QFieldExp[] {
    return fields.map((field) => ({
      field: this.quoteFieldRef(field.field, scope),
      value: this.quoteExpr(field.value, scope),
    }));
  }

  /** `\case` and tuple sections, which the conversion writes as lambdas of generated variables. */
  private quoteLambdaSugar(expr: Extract<Expr, { kind: 'lambda' }>, scope: LocalScope): QExpr | undefined {
    if (!expr.generated) return undefined;
    const generated = new Set(expr.pats.flatMap((pat) => (pat.kind === 'pvar' ? [pat.name.name] : [])));
    const { body } = expr;
    if (body.kind === 'case' && body.what === LAMBDA_CASE) {
      return { k: 'lamCase', alts: body.alts.map((alt) => this.quoteMatch(alt, scope)) };
    }
    if (body.kind === 'tuple') {
      const elems = body.elems.map((elem) =>
        elem.kind === 'var' && generated.has(elem.name.name) ? undefined : this.quoteExpr(elem, scope)
      );
      return { k: 'tupleSection', elems };
    }
    return undefined;
  }

  private quoteCase(expr: Extract<Expr, { kind: 'case' }>, scope: LocalScope): QExpr {
    if (expr.what === MULTI_WAY_IF) {
      const rhs = expr.alts[0]?.rhs;
      if (rhs?.body.kind !== 'guarded') throw compileError(expr.span, '書き方に誤りがあります。');
      return {
        k: 'multiIf',
        branches: rhs.body.branches.map((branch) => this.quoteGuarded(branch.guards, branch.expr, scope)),
      };
    }
    const alts = expr.alts.map((alt) => this.quoteMatch(alt, scope));
    if (expr.what === LAMBDA_CASE && expr.scrutinee.kind === 'var') return { k: 'lamCase', alts };
    return { k: 'case', scrutinee: this.quoteExpr(expr.scrutinee, scope), alts };
  }

  private quoteMatch(alt: Alt, scope: LocalScope): QMatch {
    const binders = new Map<string, LocalVar>();
    const pat = this.quotePat(alt.pat, binders, scope);
    return { pat, ...this.quoteRhs(alt.rhs, withLocals(scope, binders.values())) };
  }

  /** A right side, whose guards and bodies see its `where` bindings. */
  private quoteRhs(rhs: Rhs, scope: LocalScope): { body: QBody; where: QDecls } {
    if (rhs.implicit) throw this.unsupportedInQuote(rhs.span, 'この式');
    const where = this.quoteDeclGroup(rhs.where, scope);
    if (rhs.body.kind === 'plain') {
      return { body: { k: 'plain', expr: this.quoteExpr(rhs.body.expr, where.scope) }, where: where.decls };
    }
    const branches = rhs.body.branches.map((branch) => this.quoteGuarded(branch.guards, branch.expr, where.scope));
    return { body: { k: 'guarded', branches }, where: where.decls };
  }

  /** Guards, each of which sees the variables the guards before it bind, as the guarded expression does. */
  private quoteGuarded(guards: Guard[], expr: Expr, scope: LocalScope): QGuarded {
    const stmts = guards.map((guard): Stmt => {
      if (guard.kind === 'bool') return { kind: 'exp', expr: guard.expr, span: guard.span };
      if (guard.kind === 'let') return guard;
      return { kind: 'bind', pat: guard.pat, expr: guard.expr, span: guard.span };
    });
    const renamed = this.quoteStmts(stmts, scope);
    return { guards: renamed.stmts, expr: this.quoteExpr(expr, renamed.scope) };
  }

  /**
   * Statements, each of which sees the variables the statements before it bind: a bind's expression is outside its
   * own pattern's scope, and a `let`'s declarations are inside their own.
   */
  private quoteStmts(source: Stmt[], parent: LocalScope): { stmts: QStmt[]; scope: LocalScope } {
    let scope = parent;
    const stmts: QStmt[] = [];
    for (const stmt of source) {
      switch (stmt.kind) {
        case 'bind': {
          const expr = this.quoteExpr(stmt.expr, scope);
          const binders = new Map<string, LocalVar>();
          const pat = this.quotePat(stmt.pat, binders, scope);
          scope = withLocals(scope, binders.values());
          stmts.push({ k: 'bind', pat, expr });
          break;
        }
        case 'let': {
          if (stmt.implicit) throw this.unsupportedInQuote(stmt.span, 'この式');
          const group = this.quoteDeclGroup(stmt.decls, scope);
          scope = group.scope;
          stmts.push({ k: 'let', decls: group.decls });
          break;
        }
        case 'exp': {
          stmts.push({ k: 'exp', expr: this.quoteExpr(stmt.expr, scope) });
          break;
        }
        default: {
          throw this.unsupportedInQuote(stmt.span, 'この文');
        }
      }
    }
    return { stmts, scope };
  }

  /**
   * A quoted pattern, whose variables go into `binders`, or are the ones `declared` has when a declaration group
   * declared them. A view pattern's expression sees the variables bound to its left, not those of its own pattern or
   * after it.
   */
  // code-gauge-allow functionCognitiveComplexity -- One short case per pattern kind a quote may hold.
  // code-gauge-allow functionNcss -- One short case per pattern kind a quote may hold.
  private quotePat(
    pat: Pat,
    binders: Map<string, LocalVar>,
    scope: LocalScope,
    declared?: ReadonlyMap<string, LocalVar>
  ): QPat {
    const sub = (inner: Pat): QPat => this.quotePat(inner, binders, scope, declared);
    switch (pat.kind) {
      case 'pvar': {
        return { k: 'var', local: this.bindPatVar(pat.name, binders, declared) };
      }
      case 'pwild': {
        return { k: 'wild' };
      }
      case 'plit': {
        return { k: 'lit', lit: pat.lit, negative: pat.negative };
      }
      case 'pcon': {
        if (!pat.con.qualifier && pat.con.name === '()' && pat.args.length === 0) return { k: 'tuple', elems: [] };
        return { k: 'con', con: this.quoteConRef(pat.con, scope, true), args: pat.args.map(sub) };
      }
      case 'ptuple':
      case 'plist': {
        return { k: pat.kind === 'ptuple' ? 'tuple' : 'list', elems: pat.elems.map(sub) };
      }
      case 'pas': {
        const local = this.bindPatVar(pat.name, binders, declared);
        return { k: 'as', local, pat: sub(pat.pat) };
      }
      case 'precord': {
        if (pat.wildcard) throw this.unsupportedInQuote(pat.span, 'レコードのワイルドカード');
        const fields = pat.fields.map((field) => ({
          field: this.quoteFieldRef(field.field, scope),
          pat: sub(field.pat),
        }));
        return { k: 'record', con: this.quoteConRef(pat.con, scope, true), fields };
      }
      case 'pchain': {
        const operators = new Set(pat.items.flatMap((item) => (item.kind === 'operator' ? [item.op] : [])));
        const infix = (node: Pat): QPat => {
          if (node.kind !== 'pcon' || !operators.has(node.con as Operator)) return sub(node);
          const left = infix(node.args[0]);
          return { k: 'infix', left, con: this.quoteConRef(node.con, scope, true), right: infix(node.args[1]) };
        };
        return infix(resolvePatChain(pat.items, pat.span, (op) => this.fixityOf(op, scope)));
      }
      case 'pbang':
      case 'plazy': {
        return { k: pat.kind === 'pbang' ? 'bang' : 'lazy', pat: sub(pat.pat) };
      }
      case 'pview': {
        const expr = this.quoteExpr(pat.expr, withLocals(scope, binders.values()));
        return { k: 'view', expr, pat: sub(pat.pat) };
      }
      case 'psig': {
        return { k: 'sig', pat: sub(pat.pat), type: this.quoteType(pat.type, scope) };
      }
      default: {
        throw this.unsupportedInQuote(pat.span, 'このパターン');
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of type a quote may hold.
  // code-gauge-allow functionNcss -- One case per kind of type a quote may hold.
  private quoteType(type: TypeExpr, scope: LocalScope): QType {
    switch (type.kind) {
      case 'tsplice': {
        return { k: 'splice', code: type.expr };
      }
      case 'tvar': {
        return { k: 'var', ref: this.quoteTyVarRef(type.name, scope) };
      }
      case 'tcon': {
        const { name } = type.name;
        if (!type.name.qualifier && name === '[]') return { k: 'list' };
        if (!type.name.qualifier && name === '->') return { k: 'arrow' };
        const tuple = /^\((,*)\)$/.exec(name);
        if (!type.name.qualifier && tuple) return { k: 'tupleCon', arity: tuple[1].length + (tuple[1] ? 1 : 0) };
        return { k: 'con', ref: this.quoteTypeRef(type.name, scope) };
      }
      case 'tapp': {
        return { k: 'app', fn: this.quoteType(type.fn, scope), arg: this.quoteType(type.arg, scope) };
      }
      case 'tfun': {
        if (type.multiplicity) throw this.unsupportedInQuote(type.span, '線形型の矢印');
        const from: QType = { k: 'app', fn: { k: 'arrow' }, arg: this.quoteType(type.from, scope) };
        return { k: 'app', fn: from, arg: this.quoteType(type.to, scope) };
      }
      case 'tlist': {
        return { k: 'app', fn: { k: 'list' }, arg: this.quoteType(type.elem, scope) };
      }
      case 'ttuple': {
        let result: QType = { k: 'tupleCon', arity: type.elems.length };
        for (const elem of type.elems) result = { k: 'app', fn: result, arg: this.quoteType(elem, scope) };
        return result;
      }
      case 'tlit': {
        return { k: 'lit', value: type.value };
      }
      case 'tforall': {
        return this.quoteForall(type.binders, type.context, type.body, scope);
      }
      default: {
        throw this.unsupportedInQuote(type.span, 'この型');
      }
    }
  }

  /** A signature's type, quantified over the variables it names that nothing outside binds, as GHC gives it. */
  private quoteSigType(sig: SigType, scope: LocalScope): QType {
    const binders = sig.forall ?? this.implicitTyVars([...sig.context, sig.type], scope, sig.span);
    if (binders.length === 0 && sig.context.length === 0) return this.quoteType(sig.type, scope);
    return this.quoteForall(binders, sig.context, sig.type, scope);
  }

  /** The type variables types name that nothing in scope binds, in order, as binders. */
  private implicitTyVars(types: TypeExpr[], scope: LocalScope, span: Span): TyVarBinder[] {
    const names = new Set<string>();
    for (const type of types) collectTypeVars(type, names);
    return [...names].filter((name) => !scope.lookup(name, 'tyVar')).map((name) => ({ name: { name, span } }));
  }

  private quoteForall(binders: TyVarBinder[], context: TypeExpr[], body: TypeExpr, scope: LocalScope): QType {
    const tyVars = binders.map((binder): QTyVar => {
      const local = this.newBinder(binder.name.name, binder.name.span, 'tyVar');
      return {
        local,
        flag: binder.inferred ? 'inferred' : 'specified',
        kind: binder.kind && this.quoteKind(binder.kind, scope),
      };
    });
    const inner = withLocals(
      scope,
      tyVars.map((tyVar) => tyVar.local),
      'tyVar'
    );
    return {
      k: 'forall',
      binders: tyVars,
      context: context.map((constraint) => this.quoteType(constraint, inner)),
      body: this.quoteType(body, inner),
    };
  }

  /** A binder's kind annotation, whose `Type` and `Constraint` the tree holds as `StarT` and `ConstraintT`. */
  private quoteKind(kind: TypeExpr, scope: LocalScope): QType {
    switch (kind.kind) {
      case 'tcon': {
        if (kind.name.qualifier) break;
        if (kind.name.name === 'Type' || kind.name.name === '*') return { k: 'star' };
        if (kind.name.name === 'Constraint') return { k: 'constraint' };
        break;
      }
      case 'tfun': {
        const from: QType = { k: 'app', fn: { k: 'arrow' }, arg: this.quoteKind(kind.from, scope) };
        return { k: 'app', fn: from, arg: this.quoteKind(kind.to, scope) };
      }
      case 'tapp': {
        return { k: 'app', fn: this.quoteKind(kind.fn, scope), arg: this.quoteKind(kind.arg, scope) };
      }
      default: {
        break;
      }
    }
    return this.quoteType(kind, scope);
  }

  /**
   * The type variables a declaration's head binds, each of which it requires, with the kinds their annotations give
   * them, and the scope they are in.
   */
  private quoteHeadTyVars(
    params: Name[],
    kinds: (TypeExpr | undefined)[] | undefined,
    scope: LocalScope
  ): { params: QTyVar[]; scope: LocalScope } {
    const tyVars = params.map((param, index): QTyVar => {
      const kind = kinds?.[index];
      return {
        local: this.newBinder(param.name, param.span, 'tyVar'),
        flag: 'required',
        ...(kind ? { kind: this.quoteKind(kind, scope) } : {}),
      };
    });
    return {
      params: tyVars,
      scope: withLocals(
        scope,
        tyVars.map((tyVar) => tyVar.local),
        'tyVar'
      ),
    };
  }

  /**
   * A quoted group of declarations, which see what each other binds, as the code after the group does, with the
   * fixities the group declares.
   */
  private quoteDeclGroup(decls: Decl[], parent: LocalScope): { decls: QDecls; scope: LocalScope } {
    const { values, others } = this.declareQuoteGroup(decls);
    const cons = new Map(others.flatMap(([local, namespace]) => (namespace === 'con' ? [[local.name, local]] : [])));
    applyLocalFixities(decls, (name) => values.get(name) ?? cons.get(name));
    const scope = new LocalScope(parent);
    for (const local of values.values()) scope.define(local.name, local);
    for (const [local, namespace] of others) scope.define(local.name, local, namespace);
    for (const name of decls
      .flatMap((decl) => (decl.kind === 'data' ? decl.cons : []))
      .flatMap((con) => con.fieldNames ?? [])) {
      scope.define(name.name, values.get(name.name) as LocalVar, 'field');
    }
    const renamed = this.quoteBindings(decls, scope, (name) => this.quoteValueRef(name, scope, 'var'), values);
    const binders = [...values.values(), ...others.map(([local]) => local)].toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    return { decls: { binders, decls: renamed }, scope };
  }

  /**
   * What a quoted group of declarations binds: the variables the module's binding groups collect, with its types,
   * constructors, record fields, and class methods, all of which GHC gives new names.
   */
  // code-gauge-allow functionCognitiveComplexity -- One short case per kind of declaration that binds names.
  // code-gauge-allow functionNcss -- One short case per kind of declaration that binds names.
  private declareQuoteGroup(decls: Decl[]): {
    values: Map<string, LocalVar>;
    others: [LocalVar, Exclude<LocalNamespace, 'value'>][];
  } {
    const values = new Map<string, LocalVar>();
    const others: [LocalVar, Exclude<LocalNamespace, 'value'>][] = [];
    const value = (name: Name): void => {
      if (values.has(name.name)) throw compileError(name.span, `${name.name} が重複して定義されています。`);
      values.set(name.name, this.newBinder(name.name, name.span));
    };
    const other = (name: Name, namespace: Exclude<LocalNamespace, 'value'>): LocalVar => {
      const local = this.newBinder(name.name, name.span, namespace);
      others.push([local, namespace]);
      return local;
    };
    for (const binding of groupBindings(decls)) for (const name of binding.names) value(name);
    for (const decl of decls) {
      if (decl.kind === 'data') {
        other(decl.name, 'type');
        for (const con of decl.cons) other(con.name, 'con');
        const fields = decl.cons.flatMap((con) => con.fieldNames ?? []);
        for (const field of fields) if (!values.has(field.name)) value(field);
      } else if (decl.kind === 'typeSyn') other(decl.name, 'type');
      else if (decl.kind === 'class') {
        const cls = other(decl.name, 'type');
        const names = decl.decls.flatMap((member) => (member.kind === 'sig' && !member.isDefault ? member.names : []));
        for (const name of names) value(name);
        this.quoteClassMethods.set(cls, new Map(names.map((name) => [name.name, values.get(name.name) as LocalVar])));
      }
    }
    return { values, others };
  }

  /**
   * Quoted declarations: equations (consecutive ones of a function together), signatures, fixities, and the
   * declarations of types, classes, and instances. `nameOf` gives what an equation or signature defines.
   */
  private quoteBindings(
    decls: Decl[],
    scope: LocalScope,
    nameOf: (name: Name) => QRef,
    declared?: ReadonlyMap<string, LocalVar>
  ): QDecl[] {
    const result: QDecl[] = [];
    for (let index = 0; index < decls.length; index++) {
      const decl = decls[index];
      if (decl.kind !== 'funClause') {
        result.push(...this.quoteDecl(decl, scope, nameOf, declared));
        continue;
      }
      const clauses = [decl];
      while (decls[index + 1]?.kind === 'funClause' && (decls[index + 1] as typeof decl).name.name === decl.name.name) {
        clauses.push(decls[++index] as typeof decl);
      }
      const quoted = clauses.map((clause) => this.quoteClause(clause, scope));
      result.push({ k: 'fun', name: nameOf(decl.name), clauses: quoted });
    }
    return result;
  }

  private quoteClause(clause: Extract<Decl, { kind: 'funClause' }>, scope: LocalScope): QClause {
    const binders = new Map<string, LocalVar>();
    const pats = clause.args.map((arg) => this.quotePat(arg, binders, scope));
    return { pats, ...this.quoteRhs(clause.rhs, withLocals(scope, binders.values())) };
  }

  private quoteDecl(
    decl: Decl,
    scope: LocalScope,
    nameOf: (name: Name) => QRef,
    declared?: ReadonlyMap<string, LocalVar>
  ): QDecl[] {
    switch (decl.kind) {
      case 'sig': {
        const type = this.quoteSigType(decl.sig, scope);
        return decl.names.map((name): QDecl => ({
          k: 'sig',
          name: nameOf(name),
          type,
          ...(decl.isDefault ? { isDefault: true } : {}),
        }));
      }
      case 'patBind': {
        const pat = this.quotePat(decl.pat, new Map(), scope, declared);
        return [{ k: 'val', pat, ...this.quoteRhs(decl.rhs, scope) }];
      }
      case 'fixity': {
        return decl.ops.map((op): QDecl => {
          const local = scope.lookup(op.name) ?? scope.lookup(op.name, 'con');
          const name: QRef = local ? { k: 'bound', local } : { k: 'unbound', name: op.name };
          return { k: 'fixity', assoc: decl.assoc, prec: decl.prec, name };
        });
      }
      case 'data': {
        return [this.quoteDataDecl(decl, scope)];
      }
      case 'typeSyn': {
        const head = this.quoteHeadTyVars(decl.params, decl.paramKinds, scope);
        const type = this.quoteType(decl.type, head.scope);
        return [{ k: 'tySyn', name: this.quoteTypeRef(decl.name, scope), params: head.params, type }];
      }
      case 'class': {
        return [this.quoteClassDecl(decl, scope)];
      }
      case 'instance': {
        return [this.quoteInstanceDecl(decl, scope)];
      }
      default: {
        throw this.unsupportedInQuote(decl.span, 'この宣言');
      }
    }
  }

  private quoteDataDecl(decl: Extract<Decl, { kind: 'data' }>, scope: LocalScope): QDecl {
    if (decl.instanceOf || decl.kindSig) throw this.unsupportedInQuote(decl.span, 'この data 宣言');
    const head = this.quoteHeadTyVars(decl.params, decl.paramKinds, scope);
    return {
      k: 'data',
      flavour: decl.typeData ? 'typeData' : decl.newtype ? 'newtype' : 'data',
      context: (decl.datatypeContext ?? []).map((constraint) => this.quoteType(constraint, head.scope)),
      name: this.quoteTypeRef(decl.name, scope),
      params: head.params,
      cons: decl.cons.map((con) => this.quoteCon(con, head.scope)),
      deriving: decl.deriving.map((clause) => ({
        strategy: clause.strategy,
        via: clause.via && this.quoteType(clause.via, head.scope),
        cls: { k: 'con', ref: this.quoteTypeRef(clause.cls, scope) },
      })),
    };
  }

  private quoteCon(con: ConDecl, scope: LocalScope): QCon {
    if (con.exVars || con.context || con.result) throw this.unsupportedInQuote(con.span, 'この構成子');
    const fields = con.fields.map((type, index) => {
      const fieldName = con.fieldNames?.[index];
      return {
        name: fieldName && this.quoteValueRef(fieldName, scope, 'value', true),
        bang: con.bangs?.[index],
        type: this.quoteType(type, scope),
      };
    });
    return { name: this.quoteConRef(con.name, scope, true), fields, infix: con.isInfix && !con.fieldNames };
  }

  private quoteClassDecl(decl: Extract<Decl, { kind: 'class' }>, scope: LocalScope): QDecl {
    const head = this.quoteHeadTyVars(decl.params, decl.paramKinds, scope);
    const tyVar = (name: Name): QRef => this.quoteTyVarRef(name.name, head.scope);
    return {
      k: 'class',
      context: decl.context.map((constraint) => this.quoteType(constraint, head.scope)),
      name: this.quoteTypeRef(decl.name, scope),
      params: head.params,
      fundeps: decl.fundeps.map((fundep) => ({ from: fundep.from.map(tyVar), to: fundep.to.map(tyVar) })),
      decls: this.quoteBindings(decl.decls, head.scope, (name) => this.quoteValueRef(name, head.scope, 'var')),
    };
  }

  private quoteInstanceDecl(decl: Extract<Decl, { kind: 'instance' }>, scope: LocalScope): QDecl {
    if (decl.overlap) throw this.unsupportedInQuote(decl.span, 'この instance 宣言');
    const binders = this.implicitTyVars([...decl.context, ...decl.types], scope, decl.span).map((binder) =>
      this.newBinder(binder.name.name, decl.span, 'tyVar')
    );
    const inner = withLocals(scope, binders, 'tyVar');
    const cls = this.quoteTypeRef(decl.cls, scope);
    let head: QType = { k: 'con', ref: cls };
    for (const type of decl.types) head = { k: 'app', fn: head, arg: this.quoteType(type, inner) };
    return {
      k: 'instance',
      binders,
      context: decl.context.map((constraint) => this.quoteType(constraint, inner)),
      head,
      decls: this.quoteBindings(decl.decls, inner, (name) => this.quoteMethodRef(cls, decl.cls, name)),
    };
  }

  /** The method an instance's equation defines: of the quote's own class, or of a class outside the quote. */
  private quoteMethodRef(cls: QRef, className: QName, name: Name): QRef {
    if (cls.k === 'bound') {
      const local = this.quoteClassMethods.get(cls.local)?.get(name.name);
      if (!local) throw compileError(name.span, `クラス ${className.name} には、メソッド ${name.name} がありません。`);
      return { k: 'bound', local };
    }
    const found = cls.k === 'global' && this.typeExists(className) ? this.lookupType(className) : undefined;
    const method =
      found?.kind === 'class' ? found.entity.methods.find((entity) => entity.name === name.name) : undefined;
    if (method) return this.globalRef('v', this.thModule('v', method), method.name);
    return this.quoteGlobal('var', name, false);
  }

  /** A quoted name, `'f` or `''T`, as GHC's `Name` of what it names. */
  private thNameCode(expr: Extract<Expr, { kind: 'thName' }>, scope: LocalScope): Expr {
    const { span } = expr;
    const namespace: LocalNamespace = expr.namespace === 'var' ? 'value' : expr.namespace;
    const local = expr.name.qualifier ? undefined : scope.lookup(expr.name.name, namespace);
    // A binder of a quote around the splice this is in has its new name, as `[| x |]` there would.
    const levelName = local?.quoteLevelName;
    if (levelName) return { kind: 'var', name: { name: levelName, span }, span };
    if (local && expr.namespace === 'var') return thCall(span, 'mkNameS', thString(span, expr.name.name));
    // The types of special syntax have names of their own in GHC.
    const special = expr.namespace === 'type' && !expr.name.qualifier ? specialTypeName(expr.name.name) : undefined;
    if (special) return globalNameCode(span, 'tc', 'ghc-internal', special[0], special[1]);
    const ref = this.quoteGlobal(expr.namespace === 'var' ? 'value' : expr.namespace, expr.name, true);
    if (ref.k === 'global') return globalNameCode(span, ref.space, ref.package, ref.module, ref.name);
    return thCall(span, 'mkName', thString(span, expr.name.name));
  }

  /**
   * The global name a quote refers to in the module's scope, otherwise an unbound name, which the code its tree is
   * spliced into binds; a `required` name must be in scope.
   */
  private quoteGlobal(namespace: QuoteNamespace, name: QName, required: boolean): QRef {
    const saved = this.namingOnly;
    this.namingOnly = true;
    try {
      const found = this.programGlobal(namespace, name);
      if (found) return found;
      if (required) {
        // The lookup reports what the scope lacks.
        if (namespace === 'con') this.lookupCon(name);
        else if (namespace === 'type') this.lookupType(name);
        else this.lookupValue(name, namespace === 'var');
      }
      return { k: 'unbound', name: name.name };
    } finally {
      this.namingOnly = saved;
    }
  }

  private programGlobal(namespace: QuoteNamespace, name: QName): QRef | undefined {
    switch (namespace) {
      case 'var': {
        if (!this.valuesNamed(name).some((entity) => entity.sort !== 'con')) return undefined;
        const entity = this.lookupValue(name, true);
        if (entity.unsupported) throw unsupportedError(name.span, entity.unsupported);
        return this.globalRef('v', this.thModule('v', entity), entity.name);
      }
      case 'value': {
        if (this.valuesNamed(name).length === 0) return undefined;
        const entity = this.lookupValue(name, false);
        if (entity.con) return this.globalRef('d', this.thModule('con', entity.con), entity.name);
        return this.globalRef('v', this.thModule('v', entity), entity.name);
      }
      case 'con': {
        if (!this.conExists(name)) return undefined;
        const con = this.lookupCon(name);
        return this.globalRef('d', this.thModule('con', con), con.name);
      }
      case 'type': {
        if (!this.typeExists(name)) return undefined;
        const like = this.lookupType(name);
        return this.globalRef('tc', this.thModule('t', like.entity), like.entity.name);
      }
    }
  }

  private conExists(name: QName): boolean {
    if (!name.qualifier && (['()', '[]', ':'].includes(name.name) || /^\((,+)\)$/.test(name.name))) return true;
    return this.valuesNamed(name).some((entity) => entity.sort === 'con');
  }

  /** The fixity of a global operator a quote applies, which an operator nothing defines lacks. */
  private quoteFixity(op: Operator): Fixity {
    if (op.isConstructor) {
      if (!op.qualifier && this.patternSynonyms.has(op.name)) return DEFAULT_FIXITY;
      return this.conExists(op) ? (this.lookupCon(op).entity.fixity ?? DEFAULT_FIXITY) : DEFAULT_FIXITY;
    }
    if (!this.valuesNamed(op).some((entity) => entity.sort !== 'con')) return DEFAULT_FIXITY;
    return this.lookupValue(op, true).fixity ?? DEFAULT_FIXITY;
  }

  /** A global name of a quote, with the package of its module: the program's own, `main`, or the library's. */
  private globalRef(space: 'v' | 'd' | 'tc', module: string, name: string): QRef {
    return { k: 'global', space, package: module === this.module.name ? 'main' : libraryPackage(module), module, name };
  }

  /** The module GHC defines a name in, which Template Haskell shows it with. */
  private thModule(kind: 'v' | 't' | 'con', of: ValueEntity | ConInfo | TypeEntity | ClassEntity): string {
    if ('tag' in of && 'arity' in of && 'fieldTypes' in of) {
      const con = of as ConInfo;
      if (con.type.special === 'tuple' || con.type.special === 'unit') return 'GHC.Internal.Tuple';
      if (con.type.special === 'list') return 'GHC.Internal.Types';
      return this.thModule('t', con.type);
    }
    const entity = of as { module: string; name: string; method?: { cls: ClassEntity } };
    if (entity.module === this.module.name) return entity.module;
    // A class's method is where its class is.
    if (entity.method) return this.thModule('t', entity.method.cls);
    const found = thNameModules().get(`${kind === 'con' ? 't' : kind} ${entity.module} ${entity.name}`);
    if (found) return found;
    if (entity.module === 'GHC.Types') {
      if (entity.name === 'Integer' || entity.name === 'Natural') return `GHC.Internal.Bignum.${entity.name}`;
      return 'GHC.Internal.Types';
    }
    return 'GHC.Internal.Base';
  }

  /**
   * The entities a global name a splice gives refers to: this module's of its name, or those the library defines
   * under its name in the module GHC defines it in, which Template Haskell's names carry; `undefined` for another
   * name, or when none matches, which then resolves by its spelling.
   */
  private globalValues(name: QName): ValueEntity[] | undefined {
    const { global } = name;
    if (!global) return undefined;
    if (global.module === this.module.name || global.module === THIS_MODULE) {
      const own = this.ownValues.get(name.name);
      return own ? [own] : undefined;
    }
    return this.globalIndex().values.get(`${global.module} ${name.name}`);
  }

  private globalTypes(name: QName): TypeLike[] | undefined {
    const { global } = name;
    if (global?.namespace !== 'type') return undefined;
    if (global.module === this.module.name || global.module === THIS_MODULE) {
      const own = this.ownTypes.get(name.name);
      return own ? [own] : undefined;
    }
    return this.globalIndex().types.get(`${global.module} ${name.name}`);
  }

  private globalIndex(): { values: Map<string, ValueEntity[]>; types: Map<string, TypeLike[]> } {
    if (this.globals) return this.globals;
    const values = new Map<string, ValueEntity[]>();
    const types = new Map<string, TypeLike[]>();
    for (const table of this.options.modules.values()) {
      for (const entity of table.values.values()) {
        const module = entity.con ? this.thModule('con', entity.con) : this.thModule('v', entity);
        addCandidate(values, `${module} ${entity.name}`, entity, (candidate) => candidate);
      }
      for (const { entity } of table.types.values()) {
        addCandidate(
          types,
          `${this.thModule('t', entity.entity)} ${entity.entity.name}`,
          entity,
          (candidate) => candidate.entity
        );
      }
    }
    this.globals = { values, types };
    return this.globals;
  }

  private resolveVar(name: QName, scope: LocalScope): VarRef {
    if (!name.qualifier && !name.global) {
      const local = scope.lookup(name.name);
      if (local && local.quoteLevelName !== undefined) {
        throw compileError(
          name.span,
          `${name.name} はクォートの中で束縛された名前なので、スプライスの中ではクォートの中でしか使えません。`
        );
      }
      if (local) return { kind: 'local', local };
    }
    const entity = this.lookupValue(name, true);
    if (entity.unsupported) throw unsupportedError(name.span, entity.unsupported);
    return { kind: 'global', entity };
  }

  private valuesNamed(name: QName): readonly ValueEntity[] {
    const global = this.globalValues(name);
    if (global) return global;
    if (name.qualifier) return this.scope.qualifiedValues.get(name.qualifier)?.get(name.name) ?? [];
    const weak = this.options.weakValues?.get(name.name);
    return weak ? [...this.scope.values.get(name.name), weak] : this.scope.values.get(name.name);
  }

  private lookupValue(name: QName, variablesOnly: boolean): ValueEntity {
    let candidates: ValueEntity[];
    const global = this.globalValues(name);
    if (global) candidates = global;
    else if (name.qualifier) {
      const table = this.scope.qualifiedValues.get(name.qualifier);
      if (!table && !this.scope.moduleAliases.has(name.qualifier)) {
        throw compileError(name.span, `モジュール ${name.qualifier} は import されていません。`);
      }
      candidates = table?.get(name.name) ?? [];
    } else {
      candidates = this.scope.values.get(name.name);
      if (candidates.length === 0) {
        const weak = this.options.weakValues?.get(name.name);
        if (weak) candidates = [weak];
      }
    }
    if (variablesOnly) candidates = candidates.filter((entity) => entity.sort !== 'con');
    return this.checkUse(this.pickOne(candidates, name, 'value'), name);
  }

  /**
   * A value the code uses: in a splice's code outside quotes, not one of the module's own, and anywhere not one of a
   * declaration that cannot be compiled before the splice runs.
   */
  private checkUse<T extends ValueEntity | TypeEntity | ClassEntity>(entity: T, name: QName, isValue = true): T {
    if (this.quoteBinders || this.namingOnly) return entity;
    if (this.inSpliceCode && isValue && entity.module === this.module.name) {
      throw new StageRestrictionError([
        {
          row: name.span.row,
          message: `${describeName(name)} はこのモジュールで定義されているので、スプライスのコードではクォートの中でしか使えません（GHC のステージ制限）。`,
        },
      ]);
    }
    if (this.pendingEntities.has(entity)) {
      throw compileError(
        name.span,
        `${describeName(name)} は、このスプライスを実行する時点ではまだコンパイルされていない宣言なので、クォートの中で名前として使うことしかできません。`
      );
    }
    return entity;
  }

  private pickOne<T extends { module: string; name: string }>(
    candidates: T[],
    name: QName,
    what: 'value' | 'type',
    originOf: (candidate: T) => object = (candidate) => candidate
  ): T {
    let found = candidates;
    if (found.length > 1) found = found.filter((entity) => !(entity as { weak?: boolean }).weak);
    // A quote names a definition of the module's own, such as one a declaration splice gave, over an import's.
    if (found.length > 1 && (this.options.ownShadowsImports || this.namingOnly || this.quoteBinders)) {
      const own = found.filter((entity) => entity.module === this.module.name);
      if (own.length === 1) found = own;
    }
    if (found.length === 1) return found[0];
    const text = describeName(name);
    if (found.length === 0) {
      const role = what === 'type' ? '型・クラスの名前' : isOperatorName(name.name) ? '演算子' : '名前';
      throw compileError(name.span, `${role} ${text} がスコープにありません。`);
    }
    const sources = found
      .flatMap((entity) =>
        [...(this.importOrigins.get(originOf(entity))?.get(name.qualifier) ?? [entity.module])].map(
          (source) => `${source}.${entity.name}`
        )
      )
      .join(' と ');
    throw compileError(name.span, `${text} が、${sources} のどれを指すか決まりません。`);
  }

  // code-gauge-allow functionCognitiveComplexity -- Constructor lookup covers special syntax, qualification and unsupported library exports.
  private lookupCon(name: QName): ConInfo {
    if (!name.qualifier) {
      if (name.name === '()') return UNIT_CON;
      if (name.name === '[]') return NIL_CON;
      if (name.name === ':') return CONS_CON;
      const tuple = /^\((,+)\)$/.exec(name.name);
      if (tuple) return tupleCon(tuple[1].length + 1);
      const unboxed = unboxedConstructor(name.name);
      if (unboxed) return unboxed;
    }
    let candidates: ValueEntity[];
    const global = this.globalValues(name);
    if (global) candidates = global;
    else if (name.qualifier) {
      const table = this.scope.qualifiedValues.get(name.qualifier);
      if (!table && !this.scope.moduleAliases.has(name.qualifier)) {
        throw compileError(name.span, `モジュール ${name.qualifier} は import されていません。`);
      }
      candidates = table?.get(name.name) ?? [];
    } else {
      candidates = this.scope.values.get(name.name);
    }
    const unsupported = candidates.find((entity) => entity.unsupported);
    if (unsupported?.unsupported) throw unsupportedError(name.span, unsupported.unsupported);
    candidates = candidates.filter((entity) => entity.sort === 'con');
    if (candidates.length === 0) {
      if (this.features.allows('requiredTypeTerms') && this.scope.types.get(name.name).length > 0) {
        throw unsupportedError(name.span, REQUIRED_TYPE_TERM);
      }
      throw compileError(name.span, `構成子 ${describeName(name)} がスコープにありません。`);
    }
    return this.checkUse(this.pickOne(candidates, name, 'value'), name).con as ConInfo;
  }

  private lookupField(name: QName, types?: readonly TypeEntity[]): FieldInfo {
    let candidates = (
      this.globalValues(name) ??
      (name.qualifier
        ? this.scope.qualifiedValues.get(name.qualifier)?.get(name.name)
        : this.scope.values.get(name.name)) ??
      []
    ).filter((entity) => entity.sort === 'field' || entity.unsupportedField);
    // A constructor or an update decides which type's field a name shared by fields of several types is.
    if (types && candidates.length > 1) {
      const ofTypes = candidates.filter((entity) => entity.field && types.includes(entity.field.type));
      if (ofTypes.length > 0) candidates = ofTypes;
    }
    if (candidates.length === 0) {
      throw compileError(name.span, `フィールド ${describeName(name)} がスコープにありません。`);
    }
    const picked = this.pickOne(candidates, name, 'value');
    if (picked.unsupported) throw unsupportedError(name.span, picked.unsupported);
    return picked.field as FieldInfo;
  }

  private lookupType(name: QName): TypeLike {
    let candidates: TypeLike[];
    const global = this.globalTypes(name);
    if (global) candidates = global;
    else if (name.qualifier) {
      const table = this.scope.qualifiedTypes.get(name.qualifier);
      if (!table && !this.scope.moduleAliases.has(name.qualifier)) {
        throw compileError(name.span, `モジュール ${name.qualifier} は import されていません。`);
      }
      candidates = table?.get(name.name) ?? [];
    } else {
      candidates = this.scope.types.get(name.name);
      if (candidates.length === 0) {
        const weak = this.options.weakTypes?.get(name.name);
        if (weak) candidates = [{ kind: 'type', entity: weak }];
      }
    }
    const picked = this.pickOne(
      candidates.map((candidate) => ({ module: candidate.entity.module, name: candidate.entity.name, candidate })),
      name,
      'type',
      (item) => item.candidate.entity
    );
    if (picked.candidate.kind === 'type' && picked.candidate.entity.unsupported) {
      throw unsupportedError(name.span, picked.candidate.entity.unsupported);
    }
    this.checkUse(picked.candidate.entity, name, false);
    return picked.candidate;
  }

  private typeFixityOf(op: Operator): Fixity {
    if (op.name === '~' && !op.qualifier) return EQUALITY_CLASS.fixity as Fixity;
    // A promoted constructor, the list's cons among them, has the fixity of the constructor.
    if (op.name === ':' && !op.qualifier) return CONS_CON.entity.fixity ?? { assoc: 'infixr', prec: 5 };
    if (
      this.features.allows('promotion') &&
      !this.typeExists(op) &&
      this.valuesNamed(op).some((e) => e.sort === 'con')
    ) {
      return this.lookupCon(op).entity.fixity ?? DEFAULT_FIXITY;
    }
    const own = op.qualifier ? undefined : this.ownTypes.get(op.name);
    const entity = own ?? this.lookupType(op);
    return entity.entity.fixity ?? DEFAULT_FIXITY;
  }

  private typeExists(name: QName): boolean {
    if (this.globalTypes(name)) return true;
    if (name.qualifier) return (this.scope.qualifiedTypes.get(name.qualifier)?.get(name.name).length ?? 0) > 0;
    return (
      this.scope.types.get(name.name).length > 0 ||
      this.ownTypes.has(name.name) ||
      this.options.weakTypes?.has(name.name) === true
    );
  }

  /**
   * Under NoStarIsType, `*` is GHC.TypeLits' multiplication, but the grammar reads `3 * 4` after another operator as
   * `3` applied to `*` and `4`: the application's parts split at each `*` into the items of a chain of products.
   */
  private starProduct(type: TypeExpr): ChainItem<TypeExpr>[] | undefined {
    if (this.features.allows('starIsType') || !hasStarArgument(type)) return undefined;
    const parts: TypeExpr[] = [];
    let head = type;
    while (head.kind === 'tapp') {
      parts.unshift(head.arg);
      head = head.fn;
    }
    parts.unshift(head);
    const items: ChainItem<TypeExpr>[] = [];
    let segment: TypeExpr[] = [];
    const flush = (): void => {
      if (segment.length === 0) throw compileError(type.span, '書き方に誤りがあります。');
      let operand = segment[0];
      for (const arg of segment.slice(1)) operand = { kind: 'tapp', fn: operand, arg, span: type.span };
      items.push({ kind: 'operand', value: operand });
      segment = [];
    };
    for (const part of parts) {
      if (part.kind !== 'tcon' || !part.star) {
        segment.push(part);
        continue;
      }
      flush();
      if (!this.features.allows('starOperator')) {
        throw compileError(part.span, '演算子の型を使うには、TypeOperators の拡張が要ります。');
      }
      items.push({ kind: 'operator', op: { name: '*', span: part.span, isConstructor: false } });
    }
    flush();
    return items;
  }

  private renameTypeName(name: QName): RType {
    let builtin: TypeEntity | undefined;
    if (!name.qualifier && name.name === '~') return { k: 'class', entity: EQUALITY_CLASS, span: name.span };
    if (!name.qualifier) {
      if (name.name === '*' && this.features.allows('starIsType')) builtin = TYPE_KIND;
      // The list's cons in a type, `t ': ts` (or `t : ts`), is its promoted constructor.
      else if (name.name === ':' && this.features.allows('promotion')) builtin = promotedType(CONS_CON);
      else if (name.name === '()') builtin = UNIT_TYPE;
      else if (name.name === '[]') builtin = LIST_TYPE;
      else if (name.name === '->') builtin = FUNCTION_TYPE;
      else {
        const tuple = /^\((,+)\)$/.exec(name.name);
        if (tuple) builtin = tupleType(tuple[1].length + 1);
        builtin ??= unboxedConstructor(name.name)?.type;
        const sum = /^\(#(\|+)#\)$/.exec(name.name);
        if (sum) builtin = unboxedSumType(sum[1].length + 1);
      }
    }
    if (builtin) return { k: 'con', entity: builtin, span: name.span };
    if (
      (this.features.allows('promotion') || (!name.qualifier && this.typeDataCons.has(name.name))) &&
      !this.typeExists(name) &&
      this.valuesNamed(name).some((entity) => entity.sort === 'con')
    ) {
      // DataKinds lets a constructor stand for its promoted type without a tick when no type has its name.
      return { k: 'con', entity: promotedType(this.lookupCon(name)), span: name.span };
    }
    const found = this.lookupType(name);
    return found.kind === 'type'
      ? { k: 'con', entity: found.entity, span: name.span }
      : { k: 'class', entity: found.entity, span: name.span };
  }

  private lookupClass(name: QName): ClassEntity {
    const found = this.lookupType(name);
    if (found.kind !== 'class') throw compileError(name.span, `${describeName(name)} は型で、クラスではありません。`);
    return found.entity;
  }
}

/** The number of arguments a kind takes, as `data T :: Type -> Type where` gives `T`. */
function kindArity(kind: TypeExpr): number {
  return kind.kind === 'tfun' ? 1 + kindArity(kind.to) : 0;
}

function rtypeArgs(type: RType): RType[] {
  const args: RType[] = [];
  let head = type;
  while (head.k === 'app') {
    args.unshift(head.arg);
    head = head.fn;
  }
  return args;
}

function collectRTypeVars(type: RType, into: Set<string>): void {
  if (type.k === 'var') into.add(type.name);
  else if (type.k === 'app') {
    collectRTypeVars(type.fn, into);
    collectRTypeVars(type.arg, into);
  } else if (type.k === 'fun') {
    collectRTypeVars(type.from, into);
    if (type.multiplicity) collectRTypeVars(type.multiplicity, into);
    collectRTypeVars(type.to, into);
  } else if (type.k === 'tuple') for (const elem of type.elems) collectRTypeVars(elem, into);
}

/** A key of a type that is the same for types equal up to the names of their variables. */
function rtypeKey(type: RType): string {
  const names = new Map<string, number>();
  const walk = (node: RType): string => {
    switch (node.k) {
      case 'var': {
        if (!names.has(node.name)) names.set(node.name, names.size);
        return `v${names.get(node.name)}`;
      }
      case 'con':
      case 'class': {
        return `c${node.entity.id}`;
      }
      case 'app': {
        return `(${walk(node.fn)} ${walk(node.arg)})`;
      }
      case 'fun': {
        return `(${walk(node.from)}${node.multiplicity ? `%${walk(node.multiplicity)}` : ''}->${walk(node.to)})`;
      }
      case 'tuple': {
        return `(${node.elems.map(walk).join(',')})`;
      }
      default: {
        return '?';
      }
    }
  };
  return walk(type);
}

/**
 * Reads the patterns at the positions of a signature's `forall a ->` binders as the type variables they bind, as
 * RequiredTypeArguments does: the arguments there are types, which run time does not pass.
 */
function withRequiredTypeArguments(binding: Extract<RBinding, { k: 'fun' }>): void {
  const required = binding.sig?.forall?.filter((binder) => binder.required).length ?? 0;
  if (required === 0) return;
  for (const clause of binding.clauses) {
    const names = clause.pats.slice(0, required).map((written) => {
      // Strict's implicit bang does not apply to a type argument, which has no value to evaluate.
      const pat = written.k === 'bang' ? written.pat : written;
      if (pat.k === 'var') return pat.local.name;
      if (pat.k === 'wild') return '_';
      throw compileError(pat.span, '型を受け取る引数には、変数を書いてください。');
    });
    clause.typeBinders = [...(clause.typeBinders ?? []), ...names];
    clause.pats = clause.pats.slice(required);
  }
}

interface PatternSynonymInfo {
  name: string;
  arity: number;
  matcher: string;
  builder?: string;
  /** A record pattern synonym's fields, which are its parameters in order. */
  fields?: string[];
}

/** The field selectors of a record pattern synonym, which match its pattern and take a parameter's value. */
function patternSynonymSelectors(decl: Extract<Decl, { kind: 'patSyn' }>, matcher: string): Decl[] {
  const { span } = decl;
  return decl.params.map((field, position): Decl => {
    const value: Name = { name: ' value', span };
    const parts = decl.params.map((_, index): Pat =>
      index === position ? { kind: 'pvar', name: value, span } : { kind: 'pwild', span }
    );
    const matched: Pat = {
      kind: 'pcon',
      con: libraryName('Just', 'GHC.Internal.Maybe', 'con', span),
      args: [parts.length === 1 ? parts[0] : { kind: 'ptuple', elems: parts, span }],
      span,
    };
    const scrutinee: Name = { name: ' record', span };
    const call: Expr = {
      kind: 'app',
      fn: { kind: 'var', name: { name: matcher, span }, span },
      arg: { kind: 'var', name: scrutinee, span },
      span,
    };
    const body: Expr = {
      kind: 'case',
      scrutinee: call,
      alts: [
        {
          pat: matched,
          rhs: { body: { kind: 'plain', expr: { kind: 'var', name: value, span } }, where: [], span },
          span,
        },
      ],
      span,
    };
    return {
      kind: 'funClause',
      name: field,
      args: [{ kind: 'pvar', name: scrutinee, span }],
      rhs: { body: { kind: 'plain', expr: body }, where: [], span },
      span,
    };
  });
}

/** The functions that implement a pattern synonym: its matcher and, unless it only matches, its builder. */
function patternSynonymFunctions(
  decl: Extract<Decl, { kind: 'patSyn' }>,
  matcher: string,
  builder: string | undefined
): Decl[] {
  const { span } = decl;
  const support = (name: string): Expr => ({ kind: 'support', name, span });
  const vars = decl.params.map((param): Expr => ({ kind: 'var', name: param, span: param.span }));
  const matched: Expr =
    vars.length === 0
      ? support('True')
      : {
          kind: 'app',
          fn: support('Just'),
          arg: vars.length === 1 ? vars[0] : { kind: 'tuple', elems: vars, span },
          span,
        };
  const scrutinee: Name = { name: ' scrutinee', span };
  const body: Expr = {
    kind: 'case',
    scrutinee: { kind: 'var', name: scrutinee, span },
    alts: [
      { pat: decl.pattern, rhs: { body: { kind: 'plain', expr: matched }, where: [], span }, span },
      {
        pat: { kind: 'pwild', span },
        rhs: { body: { kind: 'plain', expr: support(vars.length === 0 ? 'False' : 'Nothing') }, where: [], span },
        span,
      },
    ],
    span,
  };
  const functions: Decl[] = [
    {
      kind: 'funClause',
      name: { name: matcher, span },
      args: [{ kind: 'pvar', name: scrutinee, span }],
      rhs: { body: { kind: 'plain', expr: body }, where: [], span },
      span,
    },
  ];
  if (!builder) return functions;
  if (decl.builder) {
    for (const clause of decl.builder) {
      if (clause.kind === 'funClause') functions.push({ ...clause, name: { ...clause.name, name: builder } });
    }
    return functions;
  }
  functions.push({
    kind: 'funClause',
    name: { name: builder, span },
    args: decl.params.map((param): Pat => ({ kind: 'pvar', name: param, span: param.span })),
    rhs: { body: { kind: 'plain', expr: patternAsExpression(decl.pattern) }, where: [], span },
    span,
  });
  return functions;
}

/** The expression a bidirectional pattern synonym's pattern builds, `(a, b)` for `pattern P a b = (a, b)`. */
function patternAsExpression(pat: Pat): Expr {
  const { span } = pat;
  switch (pat.kind) {
    case 'pvar': {
      return { kind: 'var', name: pat.name, span };
    }
    case 'plit': {
      const lit: Expr = { kind: 'lit', lit: pat.lit, span };
      return pat.negative ? { kind: 'neg', expr: lit, span } : lit;
    }
    case 'pcon': {
      let result: Expr = { kind: 'con', name: pat.con, span };
      for (const arg of pat.args) result = { kind: 'app', fn: result, arg: patternAsExpression(arg), span };
      return result;
    }
    case 'ptuple': {
      return { kind: 'tuple', elems: pat.elems.map(patternAsExpression), span };
    }
    case 'plist': {
      return { kind: 'list', elems: pat.elems.map(patternAsExpression), span };
    }
    case 'pchain': {
      return {
        kind: 'chain',
        items: pat.items.map((item) =>
          item.kind === 'operand' ? { kind: 'operand', value: patternAsExpression(item.value) } : item
        ),
        span,
      };
    }
    case 'psig': {
      return { kind: 'typed', expr: patternAsExpression(pat.pat), sig: { context: [], type: pat.type, span }, span };
    }
    default: {
      throw compileError(
        span,
        'このパターンシノニムは式として使えないので、<- で定義するか where で作り方を書いてください。'
      );
    }
  }
}

/** A library name the renamer generates, resolved by its identity, whatever the program's scope has under it. */
function libraryName(name: string, module: string, namespace: 'con' | 'type', span: Span): QName {
  return { name, span, global: { module, namespace } };
}

/**
 * The signatures of a pattern synonym's functions, from `pattern P :: t1 -> t2 -> T`: the builder's is the same, and
 * the matcher's is `T -> Maybe (t1, t2)`.
 */
function patternSynonymSignatures(decls: Decl[], name: Name, sig: SigType): Decl[] {
  const { span } = sig;
  const params: TypeExpr[] = [];
  let result = sig.type;
  while (result.kind === 'tfun') {
    params.push(result.from);
    result = result.to;
  }
  const matched: TypeExpr =
    params.length === 0
      ? { kind: 'tcon', name: libraryName('Bool', 'GHC.Internal.Types', 'type', span), span }
      : {
          kind: 'tapp',
          fn: { kind: 'tcon', name: libraryName('Maybe', 'GHC.Internal.Maybe', 'type', span), span },
          arg: params.length === 1 ? params[0] : { kind: 'ttuple', elems: params, span },
          span,
        };
  const matcherSig: SigType = { ...sig, type: { kind: 'tfun', from: result, to: matched, span } };
  const signatures: Decl[] = [{ kind: 'sig', names: [{ name: ` match ${name.name}`, span }], sig: matcherSig, span }];
  const synonym = decls.find((decl) => decl.kind === 'patSyn' && decl.name.name === name.name);
  if (synonym?.kind === 'patSyn' && synonym.direction !== 'unidirectional') {
    signatures.push({ kind: 'sig', names: [{ name: ` build ${name.name}`, span }], sig, span });
  }
  return signatures;
}

function classParamIndex(decl: Extract<Decl, { kind: 'class' }>, name: Name): number {
  const index = decl.params.findIndex((param) => param.name === name.name);
  if (index === -1) throw compileError(name.span, `関数従属性の ${name.name} は、クラスの型変数ではありません。`);
  return index;
}

/** Adds a candidate under a key once: every table that re-exports an entity gives it, and it is one candidate. */
function addCandidate<T>(map: Map<string, T[]>, key: string, item: T, identity: (candidate: T) => unknown): void {
  const list = map.get(key) ?? [];
  if (!list.some((other) => identity(other) === identity(item))) list.push(item);
  map.set(key, list);
}

/** The namespaces of global names a quote refers to; `value` has constructors besides variables and fields. */
type QuoteNamespace = 'var' | 'value' | 'con' | 'type';

function withLocals(parent: LocalScope, locals: Iterable<LocalVar>, namespace: LocalNamespace = 'value'): LocalScope {
  const scope = new LocalScope(parent);
  for (const local of locals) scope.define(local.name, local, namespace);
  return scope;
}

/** Local declarations whose variables are declared, with the fixities they declare, before their bindings renamed. */
interface LocalDecls {
  decls: Decl[];
  raw: RawBinding[];
  locals: ReadonlyMap<string, LocalVar>;
}

/** A statement of a `rec` block with what it binds, renamed before the block's expressions. */
type RecursiveHead =
  | { k: 'bind'; stmt: Extract<Stmt, { kind: 'bind' }>; pat: RPat; locals: LocalVar[] }
  | { k: 'let'; stmt: Extract<Stmt, { kind: 'let' }>; declared: LocalDecls; locals: LocalVar[] }
  | { k: 'exp'; stmt: Extract<Stmt, { kind: 'exp' }>; locals: LocalVar[] };

/** A renamed `rec` block, whose statements are among those of its `do` until it lowers. */
interface RecursiveBlock {
  stmts: RStmt[];
  /** The index of the statement that binds each variable the block binds. */
  owners: ReadonlyMap<LocalVar, number>;
  segmented: boolean;
  scope: LocalScope;
  span: Span;
}

function applyLocalFixities(decls: Decl[], lookup: (name: string) => LocalVar | undefined): void {
  for (const decl of decls) {
    if (decl.kind !== 'fixity') continue;
    for (const op of decl.ops) {
      const local = lookup(op.name);
      if (!local) throw compileError(op.span, `結合性を宣言した ${op.name} の定義がありません。`);
      if (local.fixity) throw compileError(op.span, `${op.name} の結合性が重複して宣言されています。`);
      local.fixity = { assoc: decl.assoc, prec: decl.prec };
    }
  }
}

/** Makes statements' uses of locals refer to the locals `target` gives by their positions instead. */
function redirectLocals(stmts: RStmt[], locals: LocalVar[], target: (position: number) => LocalVar | undefined): void {
  forEachVar(stmts, (node) => {
    const position = node.ref.kind === 'local' ? locals.indexOf(node.ref.local) : -1;
    const local = position === -1 ? undefined : target(position);
    if (local) node.ref = { kind: 'local', local };
  });
}

/** Whether a use, in the statement at `index`, of a variable bound by the statement at `owner` precedes its binding. */
function isForward(owner: number, index: number, stmt: RStmt): boolean {
  return owner > index || (owner === index && stmt.k === 'bind');
}

/** The variables statements bind that are in scope after them, in the order they are bound. */
function visibleLocals(stmts: RStmt[], scope: LocalScope): LocalVar[] {
  const locals = stmts.flatMap((stmt) =>
    stmt.k === 'bind'
      ? rpatLocals(stmt.pat)
      : stmt.k === 'let'
        ? stmt.binds.bindings.flatMap((binding) =>
            binding.k === 'fun' ? [(binding.binder as { kind: 'local'; local: LocalVar }).local] : binding.binders
          )
        : []
  );
  return locals.filter((local) => scope.lookup(local.name) === local);
}

/** The tuple of variables' values: unit for none, and the value itself for one. */
function tupleExpr(locals: LocalVar[], span: Span): RExpr {
  return locals.length === 1
    ? localExpr(locals[0], span)
    : tupleOfExprs(
        locals.map((local) => localExpr(local, span)),
        span
      );
}

function tupleOfExprs(elems: RExpr[], span: Span): RExpr {
  return elems.length === 0 ? { k: 'con', con: UNIT_CON, span } : { k: 'tuple', elems, span };
}

/** New variables of the names of variables, with the pattern of their tuple, as `tupleExpr` builds it. */
function freshTuple(locals: LocalVar[], span: Span): { fresh: LocalVar[]; pat: RPat } {
  const fresh = locals.map((local) => newLocal(local.name, local.span));
  const pats = fresh.map((local): RPat => ({ k: 'var', local, span }));
  const pat: RPat =
    pats.length === 1
      ? pats[0]
      : { k: 'con', con: pats.length === 0 ? UNIT_CON : tupleCon(pats.length), args: pats, span };
  return { fresh, pat };
}

function localExpr(local: LocalVar, span: Span): RExpr {
  return { k: 'var', ref: { kind: 'local', local }, name: local.name, span };
}

function applyExpr(fn: RExpr, args: RExpr[], span: Span): RExpr {
  let result = fn;
  for (const arg of args) result = { k: 'app', fn: result, arg, span };
  return result;
}

/** Whether a variable is a named typed hole: an unqualified name starting with `_` that nothing defines. */
function isHoleName(name: QName, scope: LocalScope, lookup: (name: QName) => readonly ValueEntity[]): boolean {
  if (name.qualifier || !name.name.startsWith('_')) return false;
  return !scope.lookup(name.name) && lookup(name).length === 0;
}

/** A pattern with the `..` of its record patterns replaced by the fields it binds, as variables of the same names. */
function expandRecordWildcards(pat: Pat, resolve: (name: QName) => readonly string[]): Pat {
  const expanded = mapPatChildren(pat, { pat: (inner) => expandRecordWildcards(inner, resolve), expr: (expr) => expr });
  if (expanded.kind !== 'precord' || !expanded.wildcard) return expanded;
  const span = expanded.wildcard;
  const fields = [...expanded.fields];
  const named = new Set(fields.map((field) => field.field.name));
  for (const name of resolve(expanded.con)) {
    if (!named.has(name)) {
      fields.push({ field: { name, span }, pat: { kind: 'pvar', name: { name, span }, span }, span, byWildcard: true });
    }
  }
  return { ...expanded, fields, wildcard: undefined };
}

function patternSignatures(
  binding: Extract<RBinding, { k: 'pat' }>,
  sigs: ReadonlyMap<string, RSigType>
): Map<LocalVar, RSigType> {
  return new Map(
    binding.binders.flatMap((local) => {
      const sig = sigs.get(local.name);
      return sig ? [[local, sig] as const] : [];
    })
  );
}

interface RawBinding {
  kind: 'fun' | 'pat';
  names: Name[];
  clauses: { args: Pat[]; rhs: Rhs; span: Span }[];
  pattern?: Pat;
  span: Span;
  entities: ValueEntity[];
}

/**
 * A method binding with an instance signature, `m :: sig; m ... = e`, as `m = let m' :: sig; m' ... = e in m'`, which
 * checks that the signature is at least as general as the method's type. The local's name is one programs cannot
 * spell, so `m` in its body still names the method.
 */
function withInstanceSignature(binding: RawBinding, sig: Extract<Decl, { kind: 'sig' }>): RawBinding {
  const name = binding.names[0];
  const local: Name = { name: ` ${name.name}`, span: name.span };
  const decls: Decl[] = [
    { ...sig, names: [local] },
    ...binding.clauses.map((clause): Decl => ({
      kind: 'funClause',
      name: local,
      args: clause.args,
      rhs: clause.rhs,
      span: clause.span,
    })),
  ];
  const span = binding.span;
  const body: Expr = { kind: 'let', decls, body: { kind: 'var', name: local, span: name.span }, span };
  return { ...binding, clauses: [{ args: [], rhs: { body: { kind: 'plain', expr: body }, where: [], span }, span }] };
}

function groupBindings(decls: Decl[]): RawBinding[] {
  const bindings: RawBinding[] = [];
  const seen = new Set<string>();
  let current: RawBinding | undefined;
  for (const decl of decls) {
    if (decl.kind === 'funClause') {
      if (current?.kind === 'fun' && current.names[0].name === decl.name.name) {
        if (current.clauses[0].args.length !== decl.args.length) {
          throw compileError(decl.span, `${decl.name.name} の定義ごとに、引数の数が違います。`);
        }
        if (current.clauses[0].args.length === 0) {
          throw compileError(decl.span, `${decl.name.name} が重複して定義されています。`);
        }
        current.clauses.push({ args: decl.args, rhs: decl.rhs, span: decl.span });
        current.span = { ...current.span, endRow: decl.span.endRow, endCol: decl.span.endCol };
        continue;
      }
      if (seen.has(decl.name.name)) throw compileError(decl.span, `${decl.name.name} が重複して定義されています。`);
      seen.add(decl.name.name);
      current = {
        kind: 'fun',
        names: [decl.name],
        clauses: [{ args: decl.args, rhs: decl.rhs, span: decl.span }],
        span: decl.span,
        entities: [],
      };
      bindings.push(current);
    } else if (decl.kind === 'patBind') {
      const names: Name[] = [];
      collectPatNames(decl.pat, names);
      for (const name of names) {
        if (seen.has(name.name)) throw compileError(name.span, `${name.name} が重複して定義されています。`);
        seen.add(name.name);
      }
      current = {
        kind: 'pat',
        names,
        clauses: [{ args: [], rhs: decl.rhs, span: decl.span }],
        pattern: decl.pat,
        span: decl.span,
        entities: [],
      };
      bindings.push(current);
    } else if (decl.kind === 'sig' || decl.kind === 'fixity') {
      // Signatures and fixity declarations between clauses still split them, as in GHC.
      current = undefined;
    } else {
      current = undefined;
    }
  }
  return bindings;
}

/** Collects the variables a pattern binds, in order. */
export function collectPatNames(pat: Pat, into: Name[]): void {
  switch (pat.kind) {
    case 'pvar': {
      into.push(pat.name);
      break;
    }
    case 'pas': {
      into.push(pat.name);
      collectPatNames(pat.pat, into);
      break;
    }
    case 'pcon': {
      for (const arg of pat.args) collectPatNames(arg, into);
      break;
    }
    case 'ptuple':
    case 'plist': {
      for (const elem of pat.elems) collectPatNames(elem, into);
      break;
    }
    case 'precord': {
      for (const field of pat.fields) collectPatNames(field.pat, into);
      break;
    }
    case 'pchain': {
      for (const item of pat.items) if (item.kind === 'operand') collectPatNames(item.value, into);
      break;
    }
    case 'pbang':
    case 'plazy':
    case 'pview':
    case 'psig': {
      collectPatNames(pat.pat, into);
      break;
    }
    default: {
      break;
    }
  }
}

function replacePatLocals(pat: RPat, locals: ReadonlyMap<string, LocalVar>): void {
  const pending = [pat];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.k === 'var' || current.k === 'as') current.local = locals.get(current.local.name) as LocalVar;
    pending.push(...rpatChildren(current).pats.toReversed());
  }
}

export function collectTypeVars(type: TypeExpr, into: Set<string>): void {
  switch (type.kind) {
    case 'tvar': {
      into.add(type.name);
      break;
    }
    case 'tapp': {
      collectTypeVars(type.fn, into);
      collectTypeVars(type.arg, into);
      break;
    }
    case 'tfun': {
      collectTypeVars(type.from, into);
      if (type.multiplicity?.kind === 'var') into.add(type.multiplicity.name);
      collectTypeVars(type.to, into);
      break;
    }
    case 'tlist': {
      collectTypeVars(type.elem, into);
      break;
    }
    case 'ttuple':
    case 'tpromotedList':
    case 'tpromotedTuple': {
      for (const elem of type.elems) collectTypeVars(elem, into);
      break;
    }
    case 'tchain': {
      for (const item of type.items) if (item.kind === 'operand') collectTypeVars(item.value, into);
      break;
    }
    case 'tkinded': {
      collectTypeVars(type.type, into);
      break;
    }
    case 'timplicit': {
      collectTypeVars(type.type, into);
      break;
    }
    case 'tkindapp': {
      collectTypeVars(type.type, into);
      break;
    }
    case 'tforall': {
      const inner = new Set<string>();
      collectTypeVars(type.body, inner);
      for (const constraint of type.context) collectTypeVars(constraint, inner);
      for (const binder of type.binders) inner.delete(binder.name.name);
      for (const name of inner) into.add(name);
      break;
    }
    default: {
      break;
    }
  }
}

function rtypeMentions(type: RType, name: string): boolean {
  switch (type.k) {
    case 'var': {
      return type.name === name;
    }
    case 'con':
    case 'class': {
      return false;
    }
    case 'tuple': {
      return type.elems.some((elem) => rtypeMentions(elem, name));
    }
    case 'app': {
      return rtypeMentions(type.fn, name) || rtypeMentions(type.arg, name);
    }
    case 'fun': {
      return (
        rtypeMentions(type.from, name) ||
        rtypeMentions(type.to, name) ||
        (type.multiplicity !== undefined && rtypeMentions(type.multiplicity, name))
      );
    }
    case 'kinded':
    case 'kindapp': {
      return rtypeMentions(type.type, name);
    }
    case 'forall': {
      return (
        !type.binders.some((binder) => binder.name === name) &&
        (rtypeMentions(type.body, name) || type.context.some((constraint) => rtypeMentions(constraint, name)))
      );
    }
  }
}

/** The associated families of a class a module exports, which `C(..)` and `C(F)` import with it. */
function associatedTypes(
  exports: ExportTable,
  parent: TypeLike
): [string, { entity: TypeLike; children: ValueEntity[] }][] {
  if (parent.kind !== 'class') return [];
  const cls = parent.entity;
  return [...exports.types].filter(
    ([, entry]) =>
      entry.entity.kind === 'type' &&
      entry.entity.entity.associatedClass === cls.name &&
      entry.entity.entity.module === cls.module
  );
}

function importChildren(item: ImportItem, available: ValueEntity[], hiding: boolean): ValueEntity[] {
  if (item.children === 'all') return available;
  const children: ValueEntity[] = [];
  for (const child of item.children ?? []) {
    const found = available.find((candidate) => candidate.name === child.name);
    if (found) children.push(found);
    else if (!hiding) throw compileError(child.span, `${item.name.name} の中に ${child.name} はありません。`);
  }
  return children;
}

let nameModules: Map<string, string> | undefined;

/** The modules of the library's names in GHC, by the kind of name, the module here, and the name. */
function thNameModules(): Map<string, string> {
  nameModules ??= new Map(
    Object.entries(TH_NAME_MODULES).flatMap(([module, keys]) => keys.map((key): [string, string] => [key, module]))
  );
  return nameModules;
}

/** GHC's names of the types of special syntax: lists, unit, tuples, and functions. */
function specialTypeName(name: string): [string, string] | undefined {
  if (name === '[]') return ['GHC.Internal.Types', 'List'];
  if (name === '()') return ['GHC.Internal.Tuple', 'Unit'];
  if (name === '->') return ['GHC.Internal.Types', '->'];
  const tuple = /^\((,+)\)$/.exec(name);
  return tuple ? ['GHC.Internal.Tuple', `Tuple${tuple[1].length + 1}`] : undefined;
}

/** The constructor of an unboxed tuple, `(#,#)`, or of an alternative of an unboxed sum, `(#_|#)`. */
function unboxedConstructor(name: string): ConInfo | undefined {
  if (name === '(# #)') return unboxedTupleType(0).cons[0];
  if (name === '(#_#)') return unboxedTupleType(1).cons[0];
  const tuple = /^\(#(,+)#\)$/.exec(name);
  if (tuple) return unboxedTupleType(tuple[1].length + 1).cons[0];
  const sum = /^\(#(\|*)_(\|*)#\)$/.exec(name);
  if (sum) return unboxedSumType(sum[1].length + sum[2].length + 1).cons[sum[1].length];
  return undefined;
}

/** A call of a library value the compiler chooses, which code a quote builds refers to. */
function thCall(span: Span, name: string, ...args: Expr[]): Expr {
  let result: Expr = { kind: 'support', name, span };
  for (const arg of args) result = { kind: 'app', fn: result, arg, span };
  return result;
}
