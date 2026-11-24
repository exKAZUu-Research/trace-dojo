// code-gauge-allow-file fileNcss -- The renamer resolves every construct of the language against one scope structure.
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
import {
  type ClassEntity,
  type ConInfo,
  type FieldInfo,
  type Fixity,
  nextId,
  type TypeEntity,
  type ValueEntity,
} from './entities';
import { compileError, unsupportedError } from './errors';
import { ExportTableBuilder } from './exportTable';
import type { Extensions } from './extensions';
import { DEFAULT_FIXITY, resolveExprChain, resolvePatChain, resolveTypeChain, sectionOperand } from './fixity';
import { TH_NAME_MODULES } from './library/thNames';
import { LocalScope } from './localScope';
import { emptyExports, type ExportTable, type TypeLike } from './modules';
import type {
  Binder,
  LocalVar,
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
import { rpatChildren, rpatLocals, substituteRType } from './rast';
import { RecursionBudget } from './recursionBudget';
import type {
  Alt,
  Decl,
  DerivingStrategy,
  Expr,
  FieldBind,
  Import,
  ImportItem,
  Module,
  Name,
  Operator,
  OverlapMode,
  Pat,
  QName,
  Rhs,
  Role,
  SigType,
  Span,
  Stmt,
  TypeEquation,
  TypeExpr,
} from './syntax';
import { checkTypeParams } from './typeNames';
import { STAR } from './types';
import { chargeTypeWork } from './typeWorkBudget';

export interface RDataDecl {
  entity: TypeEntity;
  /** The type's parameters, or for a data instance, the variables of its types. */
  params: string[];
  /** For a data instance, the types it gives the family's parameters, in terms of `params`. */
  instanceArgs?: RType[];
  /** The kinds the parameters' annotations give, by position. */
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
  /** For a constructor in GADT syntax, the type it constructs. */
  result?: RType;
}

/** `deriving instance ctx => C (T a)`, which derives an instance with the context it states. */
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
  /** The roles `type role` declares for the module's own types. */
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
}

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

  constructor(
    private readonly module: Module,
    private readonly options: RenameOptions
  ) {}

  run(): RModule {
    this.importModules();
    this.declareTypes(this.module.decls);
    this.declareDataInstances(this.module.decls);
    const decls = this.expandBindingWildcards(this.expandPatternSynonyms(this.module.decls), (name) => {
      const own = name.qualifier ? undefined : this.ownValues.get(name.name);
      return own?.con ?? this.lookupCon(name);
    });
    const topBindings = this.declareValues(decls);
    this.addOwnToScope();
    this.applyTopFixities(decls);
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
    const children = importChildren(item, entry.children, imp.hiding);
    for (const child of children) {
      if (!imp.hiding && child.unsupported) throw unsupportedError(item.name.span, child.unsupported);
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
  }

  private declareOwnValue(name: Name, entity: ValueEntity): void {
    const existing = this.ownValues.get(name.name);
    // DuplicateRecordFields lets records of different types have fields of the same name.
    if (
      existing?.sort === 'field' &&
      entity.sort === 'field' &&
      existing.field?.type !== entity.field?.type &&
      this.module.extensions.has('DuplicateRecordFields')
    ) {
      this.duplicateFields.push(entity);
      return;
    }
    if (this.ownValues.has(name.name)) {
      throw compileError(name.span, `${name.name} が重複して定義されています。`);
    }
    this.ownValues.set(name.name, entity);
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
        strictFields: conDecl.strictFields,
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
          field = { entity: fieldEntity, type, name: fieldName.name, positions: new Map(), fieldType: STAR_TYPE };
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
        for (const type of [...conDecl.fields, conDecl.result, ...(conDecl.context ?? [])]) collectTypeVars(type, own);
      }
      const vars = new Set([...(conDecl.result ? [] : params), ...own]);
      const ownVars = conDecl.exVars
        ? conDecl.exVars.map((binder) => ({
            name: binder.name.name,
            kind: binder.kind && this.renameKind(binder.kind),
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
    if (decl.kindSig) this.dataKindSigs.push({ entity, kind: this.renameKind(decl.kindSig), span: decl.span });
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
      if (params.length > 0 && !params.some((param) => rtypeMentions(sig.type, param))) {
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
      if (!this.module.extensions.has('InstanceSigs')) {
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
        const entity = binding.entities[0];
        const renamed = this.renameFunBinding(binding, { kind: 'global', entity }, scope);
        renamed.sig = sigs.get(binding.names[0].name);
        withRequiredTypeArguments(renamed);
        return renamed;
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

  private renameFunBinding(raw: RawBinding, binder: Binder, scope: LocalScope): Extract<RBinding, { k: 'fun' }> {
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
    return { k: 'fun', binder, clauses, span: raw.span };
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

  // code-gauge-allow functionCognitiveComplexity -- Local declarations combine signatures, fixities, and bindings in one scope.
  // code-gauge-allow functionNcss -- Local declarations combine signatures, fixities, and bindings in one scope.
  renameLocalDecls(sourceDecls: Decl[], parent: LocalScope): { group: RBindGroup; scope: LocalScope } {
    const scope = new LocalScope(parent);
    const decls = this.expandBindingWildcards(sourceDecls, (name) => this.lookupCon(name));
    for (const decl of decls) {
      if (decl.kind === 'data' || decl.kind === 'typeSyn' || decl.kind === 'class' || decl.kind === 'instance') {
        throw compileError(decl.span, 'data・type・class・instance の宣言は、最上位にだけ書けます。');
      }
    }
    const raw = groupBindings(decls);
    for (const binding of raw) {
      for (const name of binding.names) {
        if (scope.vars.has(name.name)) throw compileError(name.span, `${name.name} が重複して定義されています。`);
        scope.define(name.name, newLocal(name.name, name.span));
      }
    }
    for (const decl of decls) {
      if (decl.kind !== 'fixity') continue;
      for (const op of decl.ops) {
        const local = scope.vars.get(op.name);
        if (!local) throw compileError(op.span, `結合性を宣言した ${op.name} の定義がありません。`);
        if (local.fixity) throw compileError(op.span, `${op.name} の結合性が重複して宣言されています。`);
        local.fixity = { assoc: decl.assoc, prec: decl.prec };
      }
    }
    const sigs = this.collectSigs(decls, raw, (name) => scope.vars.get(name));
    const bindings: RBinding[] = raw.map((binding) => {
      if (binding.kind === 'fun') {
        const local = scope.vars.get(binding.names[0].name) as LocalVar;
        const renamed = this.renameFunBinding(binding, { kind: 'local', local }, scope);
        renamed.sig = sigs.get(local.name);
        withRequiredTypeArguments(renamed);
        return renamed;
      }
      const renamed = this.renamePatBinding(binding, scope);
      // The pattern's variables are the ones the group declared.
      renamed.binders = renamed.binders.map((local) => scope.vars.get(local.name) as LocalVar);
      replacePatLocals(renamed.pat, scope);
      renamed.patSigs = patternSignatures(renamed, sigs);
      return renamed;
    });
    return { group: { bindings }, scope };
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
    return this.recursion.run(() => this.renameExprCore(expr, scope));
  }

  // code-gauge-allow functionNcss -- One short case per expression kind.
  private renameExprCore(expr: Expr, scope: LocalScope): RExpr {
    const { span } = expr;
    switch (expr.kind) {
      case 'var': {
        if (isHoleName(expr.name, scope, (name) => this.valuesNamed(name))) {
          return { k: 'hole', name: expr.name.name, span };
        }
        return { k: 'var', ref: this.resolveVar(expr.name, scope), name: describeName(expr.name), span };
      }
      case 'hole': {
        return { k: 'hole', name: expr.name, span };
      }
      case 'thVar':
      case 'thName':
      case 'thChain': {
        return this.renameExpr(this.templateHaskellCode(expr, scope), scope);
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
        return {
          k: 'case',
          scrutinee: this.renameExpr(expr.scrutinee, scope),
          alts: expr.alts.map((alt) => this.renameAlt(alt, scope)),
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
        if (expr.quals.some((qual) => qual.kind === 'transform'))
          return this.renameExpr(withoutTransforms(expr), scope);
        if (this.module.extensions.has('MonadComprehensions') && !expr.parallel) {
          // `[e | x <- m, cond]` is `do { x <- m; guard cond; return e }` in any monad.
          const support = (name: string): Expr => ({ kind: 'support', name, span });
          const stmts: Stmt[] = expr.quals.map((qual) =>
            qual.kind === 'exp'
              ? { ...qual, expr: { kind: 'app', fn: support('guard'), arg: qual.expr, span: qual.span } }
              : qual
          );
          stmts.push({ kind: 'exp', expr: { kind: 'app', fn: support('return'), arg: expr.expr, span }, span });
          return this.renameExpr({ kind: 'do', stmts, span }, scope);
        }
        if (expr.parallel) return this.renameParallelComprehension(expr, scope);
        const { stmts, scope: inner } = this.renameStmts(expr.quals, scope, false);
        return { k: 'comp', expr: this.renameExpr(expr.expr, inner), quals: stmts, span };
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
          let result: Expr = { kind: 'con', name: expr.con, span };
          for (const name of synonym.fields) {
            const given = expr.fields.find((field) => field.field.name === name);
            if (!given)
              throw compileError(span, `パターンシノニム ${synonym.name} のフィールド ${name} がありません。`);
            result = { kind: 'app', fn: result, arg: given.value, span };
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

  /**
   * Renames `[e | qs1 | qs2 | ...]` as `[e | (vs1, (vs2, ...)) <- zip [vs1 | qs1] (zip [vs2 | qs2] ...)]`, where each
   * `vs` is the tuple of the variables its branch binds.
   */
  private renameParallelComprehension(expr: Extract<Expr, { kind: 'comprehension' }>, scope: LocalScope): RExpr {
    const { span } = expr;
    const branches = [expr.quals, ...(expr.parallel ?? [])].map((quals) => {
      const renamed = this.renameStmts(quals, scope, false);
      const locals = renamed.stmts.flatMap((stmt) =>
        stmt.k === 'bind'
          ? rpatLocals(stmt.pat)
          : stmt.k === 'let'
            ? stmt.binds.bindings.flatMap((binding) =>
                binding.k === 'fun' ? [(binding.binder as { kind: 'local'; local: LocalVar }).local] : binding.binders
              )
            : []
      );
      const seen = new Map<string, LocalVar>();
      for (const local of locals) seen.set(local.name, local);
      return { stmts: renamed.stmts, locals: [...seen.values()] };
    });
    const names = new Set<string>();
    for (const branch of branches) {
      for (const local of branch.locals) {
        if (names.has(local.name))
          throw compileError(local.span, `並列の内包表記の中で ${local.name} が重複しています。`);
        names.add(local.name);
      }
    }
    const tupleOf = (items: RExpr[]): RExpr =>
      items.length === 1
        ? items[0]
        : items.length === 0
          ? { k: 'con', con: UNIT_CON, span }
          : { k: 'tuple', elems: items, span };
    const zip = (fn: RExpr, left: RExpr, right: RExpr): RExpr => ({
      k: 'app',
      fn: { k: 'app', fn, arg: left, span },
      arg: right,
      span,
    });
    const zipFn: RExpr = {
      k: 'var',
      ref: { kind: 'global', entity: this.supportValue('zip', span) },
      name: 'zip',
      span,
    };
    const outer = new LocalScope(scope);
    const patterns: RPat[] = [];
    const lists: RExpr[] = [];
    for (const branch of branches) {
      const fresh = branch.locals.map((local) => newLocal(local.name, local.span));
      for (const local of fresh) outer.define(local.name, local);
      const vars = branch.locals.map((local): RExpr => ({
        k: 'var',
        ref: { kind: 'local', local },
        name: local.name,
        span,
      }));
      lists.push({ k: 'comp', expr: tupleOf(vars), quals: branch.stmts, span });
      const pats = fresh.map((local): RPat => ({ k: 'var', local, span }));
      patterns.push(
        pats.length === 1
          ? pats[0]
          : { k: 'con', con: pats.length === 0 ? UNIT_CON : tupleCon(pats.length), args: pats, span }
      );
    }
    let source = lists.at(-1) as RExpr;
    let pattern = patterns.at(-1) as RPat;
    for (let index = lists.length - 2; index >= 0; index--) {
      source = zip(zipFn, lists[index], source);
      pattern = { k: 'con', con: tupleCon(2), args: [patterns[index], pattern], span };
    }
    return {
      k: 'comp',
      expr: this.renameExpr(expr.expr, outer),
      quals: [{ k: 'bind', pat: pattern, expr: source, span }],
      span,
    };
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

  /** The fields `..` fills in a construction: each one not given whose name a variable in scope has. */
  private wildcardFields(con: ConInfo, given: FieldBind[], span: Span, scope: LocalScope): FieldBind[] {
    const named = new Set(given.map((bind) => bind.field.name));
    return (con.fieldNames ?? []).flatMap((name) => {
      if (named.has(name)) return [];
      const defined =
        scope.lookup(name) !== undefined ||
        this.scope.values.get(name).some((entity) => entity.sort === 'var' && entity.module === this.module.name);
      return defined
        ? [{ field: { name, span }, value: { kind: 'var', name: { name, span }, span } as Expr, span }]
        : [];
    });
  }

  private renameFieldBinds(fields: FieldBind[], scope: LocalScope, cons: ConInfo[] | undefined): RFieldBind[] {
    const seen = new Set<string>();
    const types = cons ? [cons[0].type] : this.updatedTypes(fields);
    return fields.map((fieldBind) => {
      const field = this.lookupField(fieldBind.field, types);
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

  private renameStmts(source: Stmt[], parent: LocalScope, isDo: boolean): { stmts: RStmt[]; scope: LocalScope } {
    let scope = parent;
    const result: RStmt[] = [];
    const stmts = source.map((stmt) => (stmt.kind === 'rec' ? recursiveBind(stmt) : stmt));
    for (const [index, stmt] of stmts.entries()) {
      const isLast = index === stmts.length - 1;
      switch (stmt.kind) {
        case 'exp': {
          result.push({ k: 'exp', expr: this.renameExpr(stmt.expr, scope), span: stmt.span });
          break;
        }
        case 'bind': {
          if (isDo && isLast) throw compileError(stmt.span, 'do の最後の文は、式にしてください（<- で終われません）。');
          const expr = this.renameExpr(stmt.expr, scope);
          const binders = new Map<string, LocalVar>();
          const pat = this.renamePat(stmt.pat, binders, scope);
          scope = new LocalScope(scope);
          for (const [name, local] of binders) scope.define(name, local);
          result.push({ k: 'bind', pat, expr, span: stmt.span });
          break;
        }
        case 'transform': {
          throw compileError(stmt.span, 'then は、リストの内包表記の中にだけ書けます。');
        }
        case 'let': {
          if (isDo && isLast)
            throw compileError(stmt.span, 'do の最後の文は、式にしてください（let で終われません）。');
          const local = this.renameLocalDecls(stmt.decls, scope);
          scope = local.scope;
          result.push({ k: 'let', binds: local.group, span: stmt.span });
          break;
        }
      }
    }
    return { stmts: result, scope };
  }

  private fixityOf(op: Operator, scope: LocalScope): Fixity {
    if (!op.qualifier && !op.isConstructor) {
      const local = scope.lookup(op.name);
      if (local) return local.fixity ?? DEFAULT_FIXITY;
    }
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
          resolvePatChain(pat.items, span, (op) =>
            !op.qualifier && this.patternSynonyms.has(op.name)
              ? DEFAULT_FIXITY
              : (this.lookupCon(op).entity.fixity ?? DEFAULT_FIXITY)
          ),
          binders,
          scope
        );
      }
    }
  }

  /**
   * Replaces the `..` of the record patterns of pattern bindings with the fields they bind, whose names the bindings
   * must declare before their patterns are renamed.
   */
  private expandBindingWildcards(decls: Decl[], resolve: (name: QName) => ConInfo): Decl[] {
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
    if (synonym?.fields) {
      const fields = synonym.fields;
      const args = fields.map((name): Pat => {
        const given = source.fields.find((field) => field.field.name === name);
        if (given) return given.pat;
        if (source.wildcard) return { kind: 'pvar', name: { name, span: source.span }, span: source.span };
        return { kind: 'pwild', span: source.span };
      });
      for (const field of source.fields) {
        if (!fields.includes(field.field.name)) {
          throw compileError(
            field.span,
            `パターンシノニム ${synonym.name} には、フィールド ${field.field.name} がありません。`
          );
        }
      }
      return this.renameSynonymPattern(
        synonym,
        { kind: 'pcon', con: source.con, args, span: source.span },
        binders,
        scope
      );
    }
    const pat = expandRecordWildcards(source, (name) => this.lookupCon(name)) as typeof source;
    const { span } = pat;
    const con = this.lookupCon(pat.con);
    const args: RPat[] = Array.from({ length: con.arity }, () => ({ k: 'wild', span }) as RPat);
    const seen = new Set<string>();
    const order: number[] = [];
    for (const fieldPat of pat.fields) {
      const field = this.lookupField(fieldPat.field, [con.type]);
      const position = field.positions.get(con);
      if (position === undefined) {
        throw compileError(fieldPat.span, `構成子 ${con.name} には、フィールド ${field.name} がありません。`);
      }
      if (seen.has(field.name)) throw compileError(fieldPat.span, `フィールド ${field.name} が重複しています。`);
      seen.add(field.name);
      args[position] = this.renamePat(fieldPat.pat, binders, scope);
      order.push(position);
    }
    return { k: 'con', con, args, order, span };
  }

  private bindPatVar(name: Name, binders: Map<string, LocalVar>): LocalVar {
    if (binders.has(name.name)) throw compileError(name.span, `パターンの中で ${name.name} が重複しています。`);
    const local = newLocal(name.name, name.span);
    binders.set(name.name, local);
    return local;
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
        return this.renameTypeName(type.name);
      }
      case 'tapp': {
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
        return this.renameType(
          resolveTypeChain(type.items, span, (op) => this.typeFixityOf(op)),
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

  /** The code a quote builds for what needs the program's scope: names, and operator chains by their fixities. */
  private templateHaskellCode(expr: Extract<Expr, { kind: 'thVar' | 'thName' | 'thChain' }>, scope: LocalScope): Expr {
    if (expr.kind === 'thVar') return this.thVarCode(expr, scope);
    if (expr.kind === 'thName') return this.thNameCode(expr, scope);
    return this.thChainCode(expr, scope);
  }

  /** A variable or constructor of a quote: a global one's tree, a local one's lifted value, or an unbound name. */
  private thVarCode(expr: Extract<Expr, { kind: 'thVar' }>, scope: LocalScope): Expr {
    const { span } = expr;
    if (expr.constructor) {
      const con = this.lookupCon(expr.name);
      return thCall(span, 'quoteGlobalCon', thString(span, this.thModule('con', con)), thString(span, con.name));
    }
    if (expr.implicit) {
      const entity = this.supportValue(expr.name.name, span);
      return thCall(span, 'quoteGlobalVar', thString(span, this.thModule('v', entity)), thString(span, entity.name));
    }
    // A name nothing binds stays unbound in the tree, for the code it is spliced into to bind, as GHC does.
    if (!(!expr.name.qualifier && scope.lookup(expr.name.name)) && this.valuesNamed(expr.name).length === 0) {
      return thCall(span, 'unboundVarE', thCall(span, 'mkName', thString(span, expr.name.name)));
    }
    const ref = this.resolveVar(expr.name, scope);
    // A variable of the program outside the quote is lifted: the tree of its value.
    if (ref.kind === 'local') return thCall(span, 'lift', { kind: 'var', name: expr.name, span });
    return thCall(
      span,
      'quoteGlobalVar',
      thString(span, this.thModule('v', ref.entity)),
      thString(span, ref.entity.name)
    );
  }

  /** A quoted name, `'f` or `''T`, as GHC's `Name` of what it names. */
  private thNameCode(expr: Extract<Expr, { kind: 'thName' }>, scope: LocalScope): Expr {
    const { span } = expr;
    const global = (make: string, module: string, name: string): Expr =>
      thCall(span, make, thString(span, thPackage(module)), thString(span, module), thString(span, name));
    if (expr.namespace === 'type') {
      // The types of special syntax have names of their own in GHC.
      const special = expr.name.qualifier ? undefined : specialTypeName(expr.name.name);
      if (special) return global('mkNameG_tc', special[0], special[1]);
      const like = this.lookupType(expr.name);
      return global('mkNameG_tc', this.thModule('t', like.entity), like.entity.name);
    }
    if (expr.namespace === 'con') {
      const con = this.lookupCon(expr.name);
      return global('mkNameG_d', this.thModule('con', con), con.name);
    }
    if (!expr.name.qualifier && scope.lookup(expr.name.name)) {
      return thCall(span, 'mkNameS', thString(span, expr.name.name));
    }
    const entity = this.lookupValue(expr.name, false);
    if (entity.con) return global('mkNameG_d', this.thModule('con', entity.con), entity.name);
    return global('mkNameG_v', this.thModule('v', entity), entity.name);
  }

  /** An operator chain of a quote, whose fixities decide how its `InfixE` or `InfixP` trees nest. */
  private thChainCode(expr: Extract<Expr, { kind: 'thChain' }>, scope: LocalScope): Expr {
    const { span } = expr;
    const resolved = resolveExprChain(expr.items, span, (op) => this.fixityOf(op, scope));
    const operatorOf = (op: Operator): Expr => {
      const found =
        expr.operators.get(op) ??
        [...expr.operators].find(([key]) => key.name === op.name && key.span.col === op.span.col)?.[1];
      if (!found) throw compileError(op.span, '書き方に誤りがあります。');
      return found;
    };
    const build = (node: Expr): Expr => {
      if (node.kind === 'neg') return thCall(span, 'appE', expr.negate, build(node.expr));
      if (node.kind !== 'binop') return node;
      const [left, right] = [build(node.left), build(node.right)];
      if (expr.pattern) return thCall(span, 'infixP', left, operatorOf(node.op), right);
      return thCall(span, 'infixE', thCall(span, 'Just', left), operatorOf(node.op), thCall(span, 'Just', right));
    };
    return build(resolved);
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
      return entity.name === 'Integer' ? 'GHC.Internal.Bignum.Integer' : 'GHC.Internal.Types';
    }
    return 'GHC.Internal.Base';
  }

  private resolveVar(name: QName, scope: LocalScope): VarRef {
    if (!name.qualifier) {
      const local = scope.lookup(name.name);
      if (local) return { kind: 'local', local };
    }
    const entity = this.lookupValue(name, true);
    if (entity.unsupported) throw unsupportedError(name.span, entity.unsupported);
    return { kind: 'global', entity };
  }

  private valuesNamed(name: QName): readonly ValueEntity[] {
    if (name.qualifier) return this.scope.qualifiedValues.get(name.qualifier)?.get(name.name) ?? [];
    const weak = this.options.weakValues?.get(name.name);
    return weak ? [...this.scope.values.get(name.name), weak] : this.scope.values.get(name.name);
  }

  private lookupValue(name: QName, variablesOnly: boolean): ValueEntity {
    let candidates: ValueEntity[];
    if (name.qualifier) {
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
    return this.pickOne(candidates, name, 'value');
  }

  private pickOne<T extends { module: string; name: string }>(
    candidates: T[],
    name: QName,
    what: 'value' | 'type',
    originOf: (candidate: T) => object = (candidate) => candidate
  ): T {
    let found = candidates;
    if (found.length > 1) found = found.filter((entity) => !(entity as { weak?: boolean }).weak);
    if (found.length > 1 && this.options.ownShadowsImports) {
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
    if (name.qualifier) {
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
    if (candidates.length === 0) throw compileError(name.span, `構成子 ${describeName(name)} がスコープにありません。`);
    return this.pickOne(candidates, name, 'value').con as ConInfo;
  }

  private lookupField(name: QName, types?: readonly TypeEntity[]): FieldInfo {
    let candidates = (
      name.qualifier
        ? (this.scope.qualifiedValues.get(name.qualifier)?.get(name.name) ?? [])
        : this.scope.values.get(name.name)
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
    if (name.qualifier) {
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
    return picked.candidate;
  }

  private typeFixityOf(op: Operator): Fixity {
    if (op.name === '~' && !op.qualifier) return EQUALITY_CLASS.fixity as Fixity;
    const own = op.qualifier ? undefined : this.ownTypes.get(op.name);
    const entity = own ?? this.lookupType(op);
    return entity.entity.fixity ?? DEFAULT_FIXITY;
  }

  private typeExists(name: QName): boolean {
    if (name.qualifier) return (this.scope.qualifiedTypes.get(name.qualifier)?.get(name.name).length ?? 0) > 0;
    return (
      this.scope.types.get(name.name).length > 0 ||
      this.ownTypes.has(name.name) ||
      this.options.weakTypes?.has(name.name) === true
    );
  }

  private renameTypeName(name: QName): RType {
    let builtin: TypeEntity | undefined;
    if (!name.qualifier && name.name === '~') return { k: 'class', entity: EQUALITY_CLASS, span: name.span };
    if (!name.qualifier) {
      if (name.name === '*') builtin = TYPE_KIND;
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
      this.module.extensions.has('DataKinds') &&
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
    const names = clause.pats.slice(0, required).map((pat) => {
      if (pat.k === 'var') return pat.local.name;
      if (pat.k === 'wild') return '_';
      throw compileError(pat.span, '型を受け取る引数には、変数を書いてください。');
    });
    clause.typeBinders = [...(clause.typeBinders ?? []), ...names];
    clause.pats = clause.pats.slice(required);
  }
}

/**
 * A comprehension with `then` qualifiers as one without: `[e | qs, then f, rs]` is `[e | vs <- f [vs | qs], rs]`,
 * where `vs` are the variables `qs` bind; `then group` rebinds each of them to the list of its values in a group.
 */
function withoutTransforms(expr: Extract<Expr, { kind: 'comprehension' }>): Expr {
  const { span } = expr;
  const index = expr.quals.findLastIndex((qual) => qual.kind === 'transform');
  const transform = expr.quals[index] as Extract<Stmt, { kind: 'transform' }>;
  const before = expr.quals.slice(0, index);
  const names: Name[] = [];
  for (const qual of before) {
    if (qual.kind === 'bind') collectPatNames(qual.pat, names);
    else if (qual.kind === 'let') for (const binding of groupBindings(qual.decls)) names.push(...binding.names);
  }
  const unique = [...new Map(names.map((name) => [name.name, name])).values()];
  const tupleExpr = (): Expr =>
    unique.length === 1
      ? { kind: 'var', name: unique[0], span }
      : unique.length === 0
        ? { kind: 'con', name: { name: '()', span }, span }
        : { kind: 'tuple', elems: unique.map((name): Expr => ({ kind: 'var', name, span })), span };
  const tuplePat = (): Pat =>
    unique.length === 1
      ? { kind: 'pvar', name: unique[0], span }
      : unique.length === 0
        ? { kind: 'pwild', span }
        : { kind: 'ptuple', elems: unique.map((name): Pat => ({ kind: 'pvar', name, span })), span };
  const app = (fn: Expr, arg: Expr): Expr => ({ kind: 'app', fn, arg, span });
  const inner: Expr = { kind: 'comprehension', expr: tupleExpr(), quals: before, span };
  let transformed = transform.by
    ? app(app(transform.fn, { kind: 'lambda', pats: [tuplePat()], body: transform.by, span }), inner)
    : app(transform.fn, inner);
  if (transform.group) {
    const group: Name = { name: ' group', span };
    const columns: Expr[] = unique.map((name) =>
      app(
        app(
          { kind: 'support', name: 'map', span },
          { kind: 'lambda', pats: [tuplePat()], body: { kind: 'var', name, span }, span }
        ),
        {
          kind: 'var',
          name: group,
          span,
        }
      )
    );
    const regroup: Expr = {
      kind: 'lambda',
      pats: [{ kind: 'pvar', name: group, span }],
      body: columns.length === 1 ? columns[0] : { kind: 'tuple', elems: columns, span },
      span,
    };
    transformed = app(app({ kind: 'support', name: 'map', span }, regroup), transformed);
  }
  return {
    ...expr,
    quals: [{ kind: 'bind', pat: tuplePat(), expr: transformed, span: transform.span }, ...expr.quals.slice(index + 1)],
  };
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
      con: { name: 'Just', span },
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
      ? { kind: 'tcon', name: { name: 'Bool', span }, span }
      : {
          kind: 'tapp',
          fn: { kind: 'tcon', name: { name: 'Maybe', span }, span },
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

function tupleOf<T>(items: T[], one: (item: T) => Expr | Pat, many: (items: T[]) => Expr | Pat): Expr | Pat {
  return items.length === 1 ? one(items[0]) : many(items);
}

/**
 * A `rec` block as the bind `vs <- mfix (\~vs -> do { ss; return vs })`, where `vs` are the variables its statements
 * bind, which then refer to their own later values.
 */
function recursiveBind(stmt: Extract<Stmt, { kind: 'rec' }>): Stmt {
  const { span } = stmt;
  const names: Name[] = [];
  for (const inner of stmt.stmts) {
    if (inner.kind === 'bind') collectPatNames(inner.pat, names);
    else if (inner.kind === 'let') for (const binding of groupBindings(inner.decls)) names.push(...binding.names);
    else if (inner.kind === 'rec') throw compileError(inner.span, 'rec の中に rec は書けません。');
  }
  const pattern = (): Pat =>
    tupleOf(
      names,
      (name) => ({ kind: 'pvar', name, span }),
      (all) =>
        all.length === 0
          ? { kind: 'pcon', con: { name: '()', span }, args: [], span }
          : { kind: 'ptuple', elems: all.map((name): Pat => ({ kind: 'pvar', name, span })), span }
    ) as Pat;
  const result = tupleOf(
    names,
    (name) => ({ kind: 'var', name, span }),
    (all) =>
      all.length === 0
        ? { kind: 'con', name: { name: '()', span }, span }
        : { kind: 'tuple', elems: all.map((name): Expr => ({ kind: 'var', name, span })), span }
  ) as Expr;
  const body: Expr = {
    kind: 'do',
    stmts: [
      ...stmt.stmts,
      { kind: 'exp', expr: { kind: 'app', fn: { kind: 'support', name: 'return', span }, arg: result, span }, span },
    ],
    span,
  };
  const lambda: Expr = { kind: 'lambda', pats: [{ kind: 'plazy', pat: pattern(), span }], body, span };
  return {
    kind: 'bind',
    pat: pattern(),
    expr: { kind: 'app', fn: { kind: 'support', name: 'mfix', span }, arg: lambda, span },
    span,
  };
}

/** Whether a variable is a named typed hole: an unqualified name starting with `_` that nothing defines. */
function isHoleName(name: QName, scope: LocalScope, lookup: (name: QName) => readonly ValueEntity[]): boolean {
  if (name.qualifier || !name.name.startsWith('_')) return false;
  return !scope.lookup(name.name) && lookup(name).length === 0;
}

/** A pattern with the `..` of its record patterns replaced by the fields it binds, as variables of the same names. */
function expandRecordWildcards(pat: Pat, resolve: (name: QName) => ConInfo): Pat {
  switch (pat.kind) {
    case 'precord': {
      const fields = pat.fields.map((field) => ({ ...field, pat: expandRecordWildcards(field.pat, resolve) }));
      if (!pat.wildcard) return { ...pat, fields };
      const span = pat.wildcard;
      const named = new Set(fields.map((field) => field.field.name));
      for (const name of resolve(pat.con).fieldNames ?? []) {
        if (!named.has(name))
          fields.push({ field: { name, span }, pat: { kind: 'pvar', name: { name, span }, span }, span });
      }
      return { ...pat, fields, wildcard: undefined };
    }
    case 'pcon': {
      return { ...pat, args: pat.args.map((arg) => expandRecordWildcards(arg, resolve)) };
    }
    case 'ptuple':
    case 'plist': {
      return { ...pat, elems: pat.elems.map((elem) => expandRecordWildcards(elem, resolve)) };
    }
    case 'pas':
    case 'pbang':
    case 'plazy':
    case 'pview':
    case 'psig': {
      return { ...pat, pat: expandRecordWildcards(pat.pat, resolve) };
    }
    case 'por': {
      return { ...pat, alts: pat.alts.map((alt) => expandRecordWildcards(alt, resolve)) };
    }
    case 'pchain': {
      return {
        ...pat,
        items: pat.items.map((item) =>
          item.kind === 'operand' ? { ...item, value: expandRecordWildcards(item.value, resolve) } : item
        ),
      };
    }
    default: {
      return pat;
    }
  }
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

const STAR_TYPE = { tag: 'tgen', index: 0 } as const;

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

function collectPatNames(pat: Pat, into: Name[]): void {
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

function replacePatLocals(pat: RPat, scope: LocalScope): void {
  const pending = [pat];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.k === 'var' || current.k === 'as') current.local = scope.vars.get(current.local.name) as LocalVar;
    pending.push(...rpatChildren(current).toReversed());
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
    case 'ttuple': {
      for (const elem of type.elems) collectTypeVars(elem, into);
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

function thPackage(module: string): string {
  return module.startsWith('GHC.') ? 'ghc-internal' : 'main';
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

function thString(span: Span, text: string): Expr {
  return { kind: 'lit', lit: { kind: 'string', value: [...text] }, span };
}

/** A call of a library value the compiler chooses, which code a quote builds refers to. */
function thCall(span: Span, name: string, ...args: Expr[]): Expr {
  let result: Expr = { kind: 'support', name, span };
  for (const arg of args) result = { kind: 'app', fn: result, arg, span };
  return result;
}
