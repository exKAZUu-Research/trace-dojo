// code-gauge-allow-file fileNcss 999 -- The renamer resolves every construct of the language against one scope structure.
import { CONS_CON, FUNCTION_TYPE, LIST_TYPE, NIL_CON, tupleCon, tupleType, UNIT_CON, UNIT_TYPE } from './builtinTypes';
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
import { type CompiledModuleInfo, emptyExports, type ExportTable, type TypeLike } from './modules';
import type {
  Binder,
  LocalVar,
  RAlt,
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
import type {
  Alt,
  ChainItem,
  Constraint,
  Decl,
  Expr,
  FieldBind,
  Import,
  ImportItem,
  Module,
  Name,
  Operator,
  Pat,
  QName,
  Rhs,
  SigType,
  Span,
  Stmt,
  TypeExpr,
} from './syntax';
import { STAR } from './types';

export interface RDataDecl {
  entity: TypeEntity;
  params: string[];
  cons: { con: ConInfo; fields: RType[] }[];
  deriving: { cls: ClassEntity; span: Span }[];
  span: Span;
}

export interface RSynonymDecl {
  entity: TypeEntity;
  params: string[];
  rhs: RType;
  span: Span;
}

export interface RClassDecl {
  entity: ClassEntity;
  param: string;
  supers: RConstraint[];
  methods: { entity: ValueEntity; sig: RSigType }[];
  defaults: RBinding[];
  span: Span;
}

export interface RInstanceDecl {
  cls: ClassEntity;
  type: RType;
  context: RConstraint[];
  bindings: RBinding[];
  span: Span;
}

export interface RModule {
  name: string;
  dataDecls: RDataDecl[];
  synonyms: RSynonymDecl[];
  classes: RClassDecl[];
  instances: RInstanceDecl[];
  values: RBindGroup;
  exports: ExportTable;
  /** Whether the module lists its exports, which then must include `main` for a program. */
  hasExportList: boolean;
}

export interface RenameOptions {
  /** The modules the module may import, by name. */
  modules: ReadonlyMap<string, CompiledModuleInfo>;
  /** Tells why a module this environment knows but does not provide cannot be imported. */
  unsupportedModule?: (name: string) => string | undefined;
  /** Whether to import `Prelude` unless the module imports it explicitly. */
  implicitPrelude: boolean;
  /** Modules every module of the library sees unqualified, without importing them. */
  ambient?: readonly ExportTable[];
  /** Values a program sees in addition to its imports, which its own definitions hide (the Turtle API). */
  weakValues?: ReadonlyMap<string, ValueEntity>;
  /** Types a program sees in addition to its imports, which its own definitions hide (`Turtle`). */
  weakTypes?: ReadonlyMap<string, TypeEntity>;
  /** Whether the module's own definitions hide imported ones of the same name, as the library's modules want. */
  ownShadowsImports?: boolean;
  /** The original entities that desugaring refers to, such as `negate` for `-x`. */
  negate?: () => ValueEntity;
}

const DEFAULT_FIXITY: Fixity = { assoc: 'infixl', prec: 9 };
/** Prefix minus binds like a left-associative operator of precedence 6. */
const NEGATE_FIXITY: Fixity = { assoc: 'infixl', prec: 6 };

class Candidates<T> {
  readonly map = new Map<string, T[]>();

  /** @param identity What makes two items the same, such as the entity a type's entry wraps. */
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

/** The names a module sees at its top level: its imports and its own definitions. */
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

class LocalScope {
  readonly vars = new Map<string, LocalVar>();

  constructor(readonly parent?: LocalScope) {}

  lookup(name: string): LocalVar | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
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

/** Resolves the names of a module, producing its renamed declarations and its export table. */
export function renameModule(module: Module, options: RenameOptions): RModule {
  return new Renamer(module, options).run();
}

class Renamer {
  private readonly scope = new GlobalScope();
  private readonly ownValues = new Map<string, ValueEntity>();
  private readonly ownTypes = new Map<string, TypeLike>();
  private readonly ownTypeChildren = new Map<TypeLike, ValueEntity[]>();
  private readonly dataDecls: RDataDecl[] = [];
  private readonly synonyms: RSynonymDecl[] = [];
  private readonly classes: RClassDecl[] = [];
  private readonly instances: RInstanceDecl[] = [];

  constructor(
    private readonly module: Module,
    private readonly options: RenameOptions
  ) {}

  run(): RModule {
    this.importModules();
    const decls = this.module.decls;
    this.declareTypes(decls);
    const topBindings = this.declareValues(decls);
    this.addOwnToScope();
    this.applyTopFixities(decls);
    for (const decl of decls) {
      if (decl.kind === 'data') this.renameData(decl);
      else if (decl.kind === 'typeSyn') this.renameSynonym(decl);
      else if (decl.kind === 'class') this.renameClass(decl);
    }
    for (const decl of decls) if (decl.kind === 'instance') this.renameInstance(decl);
    const values = this.renameTopBindings(decls, topBindings);
    return {
      name: this.module.name,
      dataDecls: this.dataDecls,
      synonyms: this.synonyms,
      classes: this.classes,
      instances: this.instances,
      values,
      exports: this.buildExports(),
      hasExportList: this.module.exports !== undefined,
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Imports and exports

  private importModules(): void {
    const imports = [...this.module.imports];
    if (this.options.implicitPrelude && !imports.some((imp) => imp.module === 'Prelude')) {
      imports.unshift({ module: 'Prelude', qualified: false, hiding: false, span: this.module.span });
    }
    for (const ambient of this.options.ambient ?? []) this.importTable(ambient, undefined, true);
    for (const imp of imports) this.importOne(imp);
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Each branch is one form of an import declaration: qualified, aliased, listed, or hiding.
  private importOne(imp: Import): void {
    const info = this.options.modules.get(imp.module);
    if (!info) {
      const reason = this.options.unsupportedModule?.(imp.module);
      if (reason !== undefined) throw unsupportedError(imp.span, reason);
      throw unsupportedError(imp.span, `モジュール ${imp.module}`);
    }
    const exports = info.exports;
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
    this.importTable(table, qualifier, !imp.qualified);
  }

  private importTable(table: ExportTable, qualifier: string | undefined, unqualified: boolean): void {
    for (const [name, entity] of table.values) {
      if (unqualified) this.scope.addValue(undefined, name, entity);
      if (qualifier !== undefined) this.scope.addValue(qualifier, name, entity);
    }
    for (const [name, entry] of table.types) {
      if (unqualified) this.scope.addType(undefined, name, entry.entity);
      if (qualifier !== undefined) this.scope.addType(qualifier, name, entry.entity);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Each branch is one form of an import item.
  private selectImportItem(exports: ExportTable, item: ImportItem, imp: Import, into: ExportTable): void {
    const { name } = item.name;
    if (item.kind === 'value') {
      const entity = exports.values.get(name);
      if (!entity) {
        if (imp.hiding) return;
        throw compileError(item.name.span, `モジュール ${imp.module} は ${name} を export していません。`);
      }
      into.values.set(name, entity);
      return;
    }
    const entry = exports.types.get(name);
    if (!entry) {
      // `hiding (C)` may name a data constructor.
      const constructor = exports.values.get(name);
      if (imp.hiding && constructor) {
        into.values.set(name, constructor);
        return;
      }
      if (imp.hiding) return;
      throw compileError(item.name.span, `モジュール ${imp.module} は ${name} を export していません。`);
    }
    into.types.set(name, { entity: entry.entity, children: [] });
    const children =
      item.children === 'all'
        ? entry.children
        : (item.children ?? []).map((child) => {
            const found = entry.children.find((candidate) => candidate.name === child.name);
            if (!found) {
              throw compileError(child.span, `${name} の中に ${child.name} はありません。`);
            }
            return found;
          });
    for (const child of children) {
      into.values.set(child.name, child);
      (into.types.get(name) as { children: ValueEntity[] }).children.push(child);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Each branch is one form of an export item.
  private buildExports(): ExportTable {
    const table = emptyExports();
    if (!this.module.exports) {
      for (const [name, entity] of this.ownValues) {
        if (entity.sort === 'var' || entity.sort === 'method' || entity.sort === 'field' || entity.sort === 'con') {
          table.values.set(name, entity);
        }
      }
      for (const [name, entity] of this.ownTypes) {
        table.types.set(name, { entity, children: this.ownTypeChildren.get(entity) ?? [] });
      }
      return table;
    }
    for (const item of this.module.exports) {
      if (item.kind === 'value') {
        const entity = this.lookupValue({ name: item.name.name, span: item.name.span }, false);
        table.values.set(item.name.name, entity);
        continue;
      }
      const entry = this.lookupType({ name: item.name.name, span: item.name.span });
      const all = this.childrenOf(entry);
      const children =
        item.children === 'all'
          ? all
          : (item.children ?? []).map((child) => {
              const found = all.find((candidate) => candidate.name === child.name);
              if (!found) throw compileError(child.span, `${item.name.name} の中に ${child.name} はありません。`);
              return found;
            });
      table.types.set(item.name.name, { entity: entry, children });
      for (const child of children) table.values.set(child.name, child);
    }
    return table;
  }

  private childrenOf(entry: TypeLike): ValueEntity[] {
    const own = this.ownTypeChildren.get(entry);
    if (own) return own;
    if (entry.kind === 'class') return entry.entity.methods;
    const type = entry.entity;
    return [...type.cons.map((con) => con.entity), ...[...type.fields.values()].map((field) => field.entity)];
  }

  // -------------------------------------------------------------------------------------------------------------
  // Top-level declarations

  // code-gauge-allow functionCognitiveComplexity 22 -- Each branch is one kind of type declaration.
  private declareTypes(decls: Decl[]): void {
    for (const decl of decls) {
      if (decl.kind === 'data' || decl.kind === 'typeSyn') {
        const entity: TypeEntity = {
          id: nextId(),
          name: decl.name.name,
          module: this.module.name,
          sort: decl.kind === 'data' ? 'data' : 'synonym',
          kind: STAR,
          arity: decl.params.length,
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
        const like: TypeLike = { kind: 'class', entity };
        this.declareOwnType(decl.name, like);
        const children: ValueEntity[] = [];
        for (const member of decl.decls) {
          if (member.kind !== 'sig') continue;
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

  private declareOwnType(name: Name, entity: TypeLike): void {
    if (this.ownTypes.has(name.name)) {
      throw compileError(name.span, `${name.name} が重複して宣言されています。`);
    }
    this.ownTypes.set(name.name, entity);
  }

  private declareOwnValue(name: Name, entity: ValueEntity): void {
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
        span: conDecl.span,
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
    this.ownTypeChildren.set(this.ownTypes.get(decl.name.name) as TypeLike, children);
  }

  /** Declares the top-level functions and pattern-bound variables, grouping each function's clauses. */
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
    for (const [name, entity] of this.ownValues) {
      this.scope.addValue(undefined, name, entity);
      this.scope.addValue(this.module.name, name, entity);
    }
    for (const [name, entity] of this.ownTypes) {
      this.scope.addType(undefined, name, entity);
      this.scope.addType(this.module.name, name, entity);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Fixities apply to values, constructors, and class methods alike.
  private applyTopFixities(decls: Decl[]): void {
    const seen = new Set<string>();
    const apply = (
      fixityDecl: Extract<Decl, { kind: 'fixity' }>,
      lookup: (name: string) => ValueEntity | undefined
    ): void => {
      for (const op of fixityDecl.ops) {
        if (seen.has(op.name)) throw compileError(op.span, `${op.name} の結合性が重複して宣言されています。`);
        seen.add(op.name);
        const entity = lookup(op.name);
        if (!entity) throw compileError(op.span, `結合性を宣言した ${op.name} の定義がありません。`);
        entity.fixity = { assoc: fixityDecl.assoc, prec: fixityDecl.prec };
      }
    };
    for (const decl of decls) {
      if (decl.kind === 'fixity') apply(decl, (name) => this.ownValues.get(name));
      if (decl.kind === 'class') {
        for (const member of decl.decls) {
          if (member.kind === 'fixity') {
            apply(member, (name) => this.ownValues.get(name)?.method && this.ownValues.get(name));
          }
        }
      }
    }
  }

  private renameData(decl: Extract<Decl, { kind: 'data' }>): void {
    const like = this.ownTypes.get(decl.name.name) as { kind: 'type'; entity: TypeEntity };
    const entity = like.entity;
    const params = this.checkTypeParams(decl.params);
    const cons = decl.cons.map((conDecl, index) => {
      const con = entity.cons[index];
      const fields = conDecl.fields.map((field) => this.renameType(field, params));
      return { con, fields };
    });
    const deriving = decl.deriving.map((name) => ({ cls: this.lookupClass(name), span: name.span }));
    this.dataDecls.push({ entity, params: decl.params.map((param) => param.name), cons, deriving, span: decl.span });
  }

  private checkTypeParams(params: Name[]): Set<string> {
    const names = new Set<string>();
    for (const param of params) {
      if (names.has(param.name)) throw compileError(param.span, `型変数 ${param.name} が重複しています。`);
      names.add(param.name);
    }
    return names;
  }

  private renameSynonym(decl: Extract<Decl, { kind: 'typeSyn' }>): void {
    const like = this.ownTypes.get(decl.name.name) as { kind: 'type'; entity: TypeEntity };
    const params = this.checkTypeParams(decl.params);
    this.synonyms.push({
      entity: like.entity,
      params: decl.params.map((param) => param.name),
      rhs: this.renameType(decl.type, params),
      span: decl.span,
    });
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Class declarations combine signatures, defaults, and fixities.
  // code-gauge-allow functionNcss 35 -- Class declarations combine signatures, defaults, and fixities.
  private renameClass(decl: Extract<Decl, { kind: 'class' }>): void {
    const like = this.ownTypes.get(decl.name.name) as { kind: 'class'; entity: ClassEntity };
    const entity = like.entity;
    const param = decl.param.name;
    const supers = decl.context.map((constraint) => {
      const renamed = this.renameConstraint(constraint, new Set([param]));
      if (renamed.type.k !== 'var' || renamed.type.name !== param) {
        throw compileError(constraint.span, 'スーパークラスの制約には、クラスの型変数だけを書いてください。');
      }
      return renamed;
    });
    const methods: RClassDecl['methods'] = [];
    for (const member of decl.decls) {
      if (member.kind !== 'sig') continue;
      const sig = this.renameSigType(member.sig);
      if (!rtypeMentions(sig.type, param)) {
        throw compileError(
          member.span,
          `クラスのメソッド ${member.names[0].name} の型に、クラスの型変数 ${param} がありません。`
        );
      }
      for (const name of member.names) {
        const method = entity.methods.find((candidate) => candidate.name === name.name) as ValueEntity;
        methods.push({ entity: method, sig });
      }
    }
    const raw = groupBindings(decl.decls.filter((member) => member.kind === 'funClause' || member.kind === 'patBind'));
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
      defaults.push(this.renameFunBinding(binding, { kind: 'global', entity: method }, new LocalScope()));
    }
    for (const member of decl.decls) {
      if (member.kind === 'fixity') continue;
      if (member.kind === 'sig' || member.kind === 'funClause' || member.kind === 'patBind') continue;
      throw compileError(member.span, 'クラスの中には、メソッドの型と既定の実装だけを書けます。');
    }
    this.classes.push({ entity, param, supers, methods, defaults, span: decl.span });
  }

  private renameInstance(decl: Extract<Decl, { kind: 'instance' }>): void {
    const cls = this.lookupClass(decl.cls);
    const vars = new Set<string>();
    collectTypeVars(decl.type, vars);
    const type = this.renameType(decl.type, vars);
    const context = decl.context.map((constraint) => this.renameConstraint(constraint, vars));
    for (const member of decl.decls) {
      if (member.kind === 'sig') throw unsupportedError(member.span, 'インスタンスの中の型シグネチャ（InstanceSigs）');
      if (member.kind === 'fixity') throw compileError(member.span, 'インスタンスの中には、結合性を宣言できません。');
    }
    const raw = groupBindings(decl.decls);
    const bindings: RBinding[] = [];
    for (const binding of raw) {
      if (binding.kind !== 'fun') throw compileError(binding.span, 'インスタンスの中では、パターンで束縛できません。');
      const name = binding.names[0];
      const method = cls.methods.find((candidate) => candidate.name === name.name);
      if (!method) throw compileError(name.span, `${name.name} は、クラス ${cls.name} のメソッドではありません。`);
      bindings.push(this.renameFunBinding(binding, { kind: 'global', entity: method }, new LocalScope()));
    }
    this.instances.push({ cls, type, context, bindings, span: decl.span });
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
        return renamed;
      }
      return this.renamePatBinding(binding, scope, (name) => this.ownValues.get(name.name) as ValueEntity);
    });
    return { bindings };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Bindings

  /** Renames the type signatures of a declaration list, checking each names a binding of the list. */
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
      const pats = clause.args.map((pat) => this.renamePat(pat, binders));
      for (const [name, local] of binders) clauseScope.vars.set(name, local);
      return { pats, rhs: this.renameRhs(clause.rhs, clauseScope), span: clause.span };
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
    const pat = this.renamePat(raw.pattern as Pat, binders);
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

  /** Renames a `let` or `where` group, whose names scope over the group itself and `scope`'s new child. */
  // code-gauge-allow functionCognitiveComplexity 29 -- Local declarations combine signatures, fixities, and bindings in one scope.
  // code-gauge-allow functionNcss 37 -- Local declarations combine signatures, fixities, and bindings in one scope.
  renameLocalDecls(decls: Decl[], parent: LocalScope): { group: RBindGroup; scope: LocalScope } {
    const scope = new LocalScope(parent);
    for (const decl of decls) {
      if (decl.kind === 'data' || decl.kind === 'typeSyn' || decl.kind === 'class' || decl.kind === 'instance') {
        throw compileError(decl.span, 'data・type・class・instance の宣言は、最上位にだけ書けます。');
      }
    }
    const raw = groupBindings(decls);
    for (const binding of raw) {
      for (const name of binding.names) {
        if (scope.vars.has(name.name)) throw compileError(name.span, `${name.name} が重複して定義されています。`);
        scope.vars.set(name.name, newLocal(name.name, name.span));
      }
    }
    for (const decl of decls) {
      if (decl.kind !== 'fixity') continue;
      for (const op of decl.ops) {
        const local = scope.vars.get(op.name);
        if (!local) throw compileError(op.span, `結合性を宣言した ${op.name} の定義がありません。`);
        local.fixity = { assoc: decl.assoc, prec: decl.prec };
      }
    }
    const sigs = this.collectSigs(decls, raw, (name) => scope.vars.get(name));
    const bindings: RBinding[] = raw.map((binding) => {
      if (binding.kind === 'fun') {
        const local = scope.vars.get(binding.names[0].name) as LocalVar;
        const renamed = this.renameFunBinding(binding, { kind: 'local', local }, scope);
        renamed.sig = sigs.get(local.name);
        return renamed;
      }
      const renamed = this.renamePatBinding(binding, scope);
      // The pattern's variables are the ones the group declared.
      renamed.binders = renamed.binders.map((local) => scope.vars.get(local.name) as LocalVar);
      replacePatLocals(renamed.pat, scope);
      if (renamed.binders.some((local) => sigs.has(local.name))) {
        renamed.patSigs = new Map();
        for (const local of renamed.binders) {
          const sig = sigs.get(local.name);
          if (sig) renamed.patSigs.set(local, sig);
        }
      }
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
        const local = this.renameLocalDecls(guard.decls, branchScope);
        branchScope = local.scope;
        return { k: 'let', binds: local.group, span: guard.span };
      });
      return { guards, expr: this.renameExpr(branch.expr, branchScope), span: branch.span };
    });
    return { body: { k: 'guarded', branches }, where, span: rhs.span };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Expressions

  // code-gauge-allow functionNcss 56 -- One short case per expression kind.
  renameExpr(expr: Expr, scope: LocalScope): RExpr {
    const { span } = expr;
    switch (expr.kind) {
      case 'var': {
        return { k: 'var', ref: this.resolveVar(expr.name, scope), name: describeName(expr.name), span };
      }
      case 'con': {
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
        return this.renameExpr(this.resolveChain(expr.items, scope, span), scope);
      }
      case 'binop':
      case 'neg': {
        return this.renameOperatorApplication(expr, scope);
      }
      case 'lambda': {
        const binders = new Map<string, LocalVar>();
        const pats = expr.pats.map((pat) => this.renamePat(pat, binders));
        const inner = new LocalScope(scope);
        for (const [name, local] of binders) inner.vars.set(name, local);
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
        const { stmts, scope: inner } = this.renameStmts(expr.quals, scope, false);
        return { k: 'comp', expr: this.renameExpr(expr.expr, inner), quals: stmts, span };
      }
      case 'leftSection': {
        const left = this.sectionOperand(expr.op, expr.left, 'infixl', scope);
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
          right: this.renameExpr(this.sectionOperand(expr.op, expr.right, 'infixr', scope), scope),
          span,
        };
      }
      case 'typed': {
        return { k: 'typed', expr: this.renameExpr(expr.expr, scope), sig: this.renameSigType(expr.sig), span };
      }
      case 'recordCon': {
        const con = this.lookupCon(expr.con);
        return { k: 'recordCon', con, fields: this.renameFieldBinds(expr.fields, scope, [con]), span };
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

  /** `a op b` as `op a b`, and `-x` as Prelude's `negate x` whatever the program's scope holds. */
  private renameOperatorApplication(expr: Extract<Expr, { kind: 'binop' | 'neg' }>, scope: LocalScope): RExpr {
    const { span } = expr;
    if (expr.kind === 'neg') {
      const negate = this.options.negate?.() ?? this.lookupValue({ name: 'negate', span }, true);
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

  private renameFieldBinds(fields: FieldBind[], scope: LocalScope, cons: ConInfo[] | undefined): RFieldBind[] {
    const seen = new Set<string>();
    return fields.map((fieldBind) => {
      const field = this.lookupField(fieldBind.field);
      if (seen.has(field.name)) throw compileError(fieldBind.span, `フィールド ${field.name} が重複しています。`);
      seen.add(field.name);
      if (cons && !cons.every((con) => field.positions.has(con))) {
        throw compileError(fieldBind.span, `構成子 ${cons[0].name} には、フィールド ${field.name} がありません。`);
      }
      return { field, value: this.renameExpr(fieldBind.value, scope), span: fieldBind.span };
    });
  }

  private renameOperator(op: Operator, scope: LocalScope): RExpr {
    if (op.isConstructor) return { k: 'con', con: this.lookupCon(op), span: op.span };
    return { k: 'var', ref: this.resolveVar(op, scope), name: describeName(op), span: op.span };
  }

  private renameAlt(alt: Alt, scope: LocalScope): RAlt {
    const binders = new Map<string, LocalVar>();
    const pat = this.renamePat(alt.pat, binders);
    const inner = new LocalScope(scope);
    for (const [name, local] of binders) inner.vars.set(name, local);
    return { pat, rhs: this.renameRhs(alt.rhs, inner), span: alt.span };
  }

  private renameStmts(stmts: Stmt[], parent: LocalScope, isDo: boolean): { stmts: RStmt[]; scope: LocalScope } {
    let scope = parent;
    const result: RStmt[] = [];
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
          const pat = this.renamePat(stmt.pat, binders);
          scope = new LocalScope(scope);
          for (const [name, local] of binders) scope.vars.set(name, local);
          result.push({ k: 'bind', pat, expr, span: stmt.span });
          break;
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

  // -------------------------------------------------------------------------------------------------------------
  // Fixity resolution

  private fixityOf(op: Operator, scope: LocalScope): Fixity {
    if (!op.qualifier && !op.isConstructor) {
      const local = scope.lookup(op.name);
      if (local) return local.fixity ?? DEFAULT_FIXITY;
    }
    const entity = op.isConstructor ? this.lookupCon(op).entity : this.lookupValue(op, true);
    return entity.fixity ?? DEFAULT_FIXITY;
  }

  /**
   * A section's operand, whose outermost operator must bind tighter than the section's operator, or as tightly with
   * the associativity that the side of the section needs.
   */
  private sectionOperand(op: Operator, operand: Expr, assoc: Fixity['assoc'], scope: LocalScope): Expr {
    if (operand.kind !== 'chain') return operand;
    const resolved = this.resolveChain(operand.items, scope, operand.span);
    if (resolved.kind !== 'binop' && resolved.kind !== 'neg') return resolved;
    const inner = resolved.kind === 'binop' ? this.fixityOf(resolved.op, scope) : NEGATE_FIXITY;
    const outer = this.fixityOf(op, scope);
    if (inner.prec > outer.prec || (inner.prec === outer.prec && inner.assoc === assoc && outer.assoc === assoc)) {
      return resolved;
    }
    const innerName = resolved.kind === 'binop' ? resolved.op.name : '-';
    throw compileError(
      op.span,
      `セクションの演算子 ${op.name} [${outer.assoc} ${outer.prec}] と、中の演算子 ${innerName} [${inner.assoc} ${inner.prec}] は、括弧なしでは書けません。`
    );
  }

  /** Resolves an operator chain by the Haskell report's algorithm, which also places prefix minus. */
  // code-gauge-allow functionCognitiveComplexity 30 -- The operator precedence algorithm of the Haskell report, including negation, reads best as one routine.
  // code-gauge-allow functionNcss 39 -- The operator precedence algorithm of the Haskell report, including negation, reads best as one routine.
  private resolveChain(items: ChainItem<Expr>[], scope: LocalScope, span: Span): Expr {
    const tokens = items;
    let position = 0;
    const fixityAt = (item: ChainItem<Expr>): Fixity =>
      item.kind === 'operator' ? this.fixityOf(item.op, scope) : NEGATE_FIXITY;
    const parseNeg = (op1: Fixity, op1Name: string): Expr => {
      const token = tokens[position];
      if (!token) throw compileError(span, '書き方に誤りがあります。');
      if (token.kind === 'negate') {
        if (op1.prec >= 6) {
          throw compileError(token.span, `前置きの - は、${op1Name} の後に括弧なしでは書けません。`);
        }
        position++;
        const operand = parseNeg(NEGATE_FIXITY, '-');
        const negated: Expr = {
          kind: 'neg',
          expr: operand,
          span: { ...token.span, endRow: operand.span.endRow, endCol: operand.span.endCol },
        };
        return parse1(op1, op1Name, negated);
      }
      if (token.kind !== 'operand') throw compileError(token.op.span, '書き方に誤りがあります。');
      position++;
      return parse1(op1, op1Name, token.value);
    };
    const parse1 = (op1: Fixity, op1Name: string, left: Expr): Expr => {
      let current = left;
      for (;;) {
        const token = tokens[position];
        if (!token) return current;
        if (token.kind !== 'operator') throw compileError(span, '書き方に誤りがあります。');
        const op2 = fixityAt(token);
        if (op1.prec === op2.prec && (op1.assoc !== op2.assoc || op1.assoc === 'infix')) {
          throw compileError(
            token.op.span,
            `演算子 ${op1Name} [${op1.assoc} ${op1.prec}] と ${token.op.name} [${op2.assoc} ${op2.prec}] は、括弧なしでは並べられません。`
          );
        }
        if (op1.prec > op2.prec || (op1.prec === op2.prec && op1.assoc === 'infixl')) return current;
        position++;
        const right = parseNeg(op2, token.op.name);
        current = {
          kind: 'binop',
          op: token.op,
          left: current,
          right,
          span: { row: current.span.row, col: current.span.col, endRow: right.span.endRow, endCol: right.span.endCol },
        };
      }
    };
    const result = parseNeg({ assoc: 'infix', prec: -1 }, '');
    if (position !== tokens.length) throw compileError(span, '書き方に誤りがあります。');
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity 28 -- The operator precedence algorithm of the Haskell report reads best as one routine.
  // code-gauge-allow functionNcss 32 -- The operator precedence algorithm of the Haskell report reads best as one routine.
  private resolvePatChain(items: ChainItem<Pat>[], span: Span): Pat {
    let position = 0;
    const parseOperand = (): Pat => {
      const token = items[position];
      if (!token || token.kind !== 'operand') {
        if (token?.kind === 'negate')
          throw compileError(token.span, 'パターンの中では、- は数のリテラルの前にだけ書けます。');
        throw compileError(span, '書き方に誤りがあります。');
      }
      position++;
      return token.value;
    };
    const parse1 = (op1: Fixity, op1Name: string, left: Pat): Pat => {
      let current = left;
      for (;;) {
        const token = items[position];
        if (!token) return current;
        if (token.kind !== 'operator') throw compileError(span, '書き方に誤りがあります。');
        if (!token.op.isConstructor) {
          throw compileError(token.op.span, `パターンの中では、関数 ${token.op.name} は使えません。`);
        }
        const op2 = this.lookupCon(token.op).entity.fixity ?? DEFAULT_FIXITY;
        if (op1.prec === op2.prec && (op1.assoc !== op2.assoc || op1.assoc === 'infix')) {
          throw compileError(token.op.span, `演算子 ${op1Name} と ${token.op.name} は、括弧なしでは並べられません。`);
        }
        if (op1.prec > op2.prec || (op1.prec === op2.prec && op1.assoc === 'infixl')) return current;
        position++;
        const right = parse1(op2, token.op.name, parseOperand());
        current = {
          kind: 'pcon',
          con: token.op,
          args: [current, right],
          span: { row: current.span.row, col: current.span.col, endRow: right.span.endRow, endCol: right.span.endCol },
        };
      }
    };
    const result = parse1({ assoc: 'infix', prec: -1 }, '', parseOperand());
    if (position !== items.length) throw compileError(span, '書き方に誤りがあります。');
    return result;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Patterns

  // code-gauge-allow functionCognitiveComplexity 16 -- One short case per pattern kind.
  // code-gauge-allow functionNcss 44 -- One short case per pattern kind.
  renamePat(pat: Pat, binders: Map<string, LocalVar>): RPat {
    const { span } = pat;
    switch (pat.kind) {
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
        const con = this.lookupCon(pat.con);
        if (pat.args.length !== con.arity) {
          throw compileError(
            span,
            `構成子 ${con.name} には ${con.arity} 個の引数が要りますが、パターンには ${pat.args.length} 個あります。`
          );
        }
        return { k: 'con', con, args: pat.args.map((arg) => this.renamePat(arg, binders)), span };
      }
      case 'ptuple': {
        const con = tupleCon(pat.elems.length);
        return { k: 'con', con, args: pat.elems.map((elem) => this.renamePat(elem, binders)), span };
      }
      case 'plist': {
        let result: RPat = { k: 'con', con: NIL_CON, args: [], span };
        const elems = pat.elems.map((elem) => this.renamePat(elem, binders));
        for (const elem of elems.toReversed()) result = { k: 'con', con: CONS_CON, args: [elem, result], span };
        return result;
      }
      case 'pas': {
        const local = this.bindPatVar(pat.name, binders);
        return { k: 'as', local, pat: this.renamePat(pat.pat, binders), span };
      }
      case 'precord': {
        const con = this.lookupCon(pat.con);
        const args: RPat[] = Array.from({ length: con.arity }, () => ({ k: 'wild', span }) as RPat);
        const seen = new Set<string>();
        for (const fieldPat of pat.fields) {
          const field = this.lookupField(fieldPat.field);
          const position = field.positions.get(con);
          if (position === undefined) {
            throw compileError(fieldPat.span, `構成子 ${con.name} には、フィールド ${field.name} がありません。`);
          }
          if (seen.has(field.name)) throw compileError(fieldPat.span, `フィールド ${field.name} が重複しています。`);
          seen.add(field.name);
          args[position] = this.renamePat(fieldPat.pat, binders);
        }
        return { k: 'con', con, args, span };
      }
      case 'pchain': {
        return this.renamePat(this.resolvePatChain(pat.items, span), binders);
      }
    }
  }

  private bindPatVar(name: Name, binders: Map<string, LocalVar>): LocalVar {
    if (binders.has(name.name)) throw compileError(name.span, `パターンの中で ${name.name} が重複しています。`);
    const local = newLocal(name.name, name.span);
    binders.set(name.name, local);
    return local;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Types

  renameSigType(sig: SigType): RSigType {
    const vars = new Set<string>();
    collectTypeVars(sig.type, vars);
    for (const constraint of sig.context) for (const type of constraint.types) collectTypeVars(type, vars);
    return {
      context: sig.context.map((constraint) => this.renameConstraint(constraint, vars)),
      type: this.renameType(sig.type, vars),
      span: sig.span,
    };
  }

  private renameConstraint(constraint: Constraint, vars: Set<string>): RConstraint {
    return {
      cls: this.lookupClass(constraint.cls),
      type: this.renameType(constraint.types[0], vars),
      span: constraint.span,
    };
  }

  renameType(type: TypeExpr, vars: ReadonlySet<string>): RType {
    const { span } = type;
    switch (type.kind) {
      case 'tvar': {
        if (!vars.has(type.name)) throw compileError(span, `型変数 ${type.name} がスコープにありません。`);
        return { k: 'var', name: type.name, span };
      }
      case 'tcon': {
        return { k: 'con', entity: this.lookupTypeEntity(type.name), span };
      }
      case 'tapp': {
        return { k: 'app', fn: this.renameType(type.fn, vars), arg: this.renameType(type.arg, vars), span };
      }
      case 'tfun': {
        return { k: 'fun', from: this.renameType(type.from, vars), to: this.renameType(type.to, vars), span };
      }
      case 'tlist': {
        return { k: 'app', fn: { k: 'con', entity: LIST_TYPE, span }, arg: this.renameType(type.elem, vars), span };
      }
      case 'ttuple': {
        let result: RType = { k: 'con', entity: tupleType(type.elems.length), span };
        for (const elem of type.elems) result = { k: 'app', fn: result, arg: this.renameType(elem, vars), span };
        return result;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lookup

  private resolveVar(name: QName, scope: LocalScope): VarRef {
    if (!name.qualifier) {
      const local = scope.lookup(name.name);
      if (local) return { kind: 'local', local };
    }
    const entity = this.lookupValue(name, true);
    if (entity.unsupported) throw unsupportedError(name.span, entity.unsupported);
    return { kind: 'global', entity };
  }

  /** Looks up a top-level value, with `variablesOnly` excluding constructors. */
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

  private pickOne<T extends { module: string; name: string }>(candidates: T[], name: QName, what: 'value' | 'type'): T {
    let found = candidates;
    if (found.length > 1) found = found.filter((entity) => !(entity as { weak?: boolean }).weak);
    if (found.length > 1 && this.options.ownShadowsImports) {
      const own = found.filter((entity) => entity.module === this.module.name);
      if (own.length === 1) found = own;
    }
    if (found.length === 1) return found[0];
    const text = describeName(name);
    if (found.length === 0) {
      if (what === 'value' && name.name.startsWith('_') && !name.qualifier) {
        throw unsupportedError(name.span, `型の穴（${name.name}）`);
      }
      const role = what === 'type' ? '型・クラスの名前' : isOperatorName(name.name) ? '演算子' : '名前';
      throw compileError(name.span, `${role} ${text} がスコープにありません。`);
    }
    const sources = found.map((entity) => `${entity.module}.${entity.name}`).join(' と ');
    throw compileError(name.span, `${text} が、${sources} のどれを指すか決まりません。`);
  }

  private lookupCon(name: QName): ConInfo {
    if (!name.qualifier) {
      if (name.name === '()') return UNIT_CON;
      if (name.name === '[]') return NIL_CON;
      if (name.name === ':') return CONS_CON;
      const tuple = /^\((,+)\)$/.exec(name.name);
      if (tuple) return tupleCon(tuple[1].length + 1);
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
    candidates = candidates.filter((entity) => entity.sort === 'con');
    if (candidates.length === 0) throw compileError(name.span, `構成子 ${describeName(name)} がスコープにありません。`);
    return this.pickOne(candidates, name, 'value').con as ConInfo;
  }

  private lookupField(name: QName): FieldInfo {
    const candidates = (
      name.qualifier
        ? (this.scope.qualifiedValues.get(name.qualifier)?.get(name.name) ?? [])
        : this.scope.values.get(name.name)
    ).filter((entity) => entity.sort === 'field');
    if (candidates.length === 0) {
      throw compileError(name.span, `フィールド ${describeName(name)} がスコープにありません。`);
    }
    return this.pickOne(candidates, name, 'value').field as FieldInfo;
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
      'type'
    );
    return picked.candidate;
  }

  private lookupTypeEntity(name: QName): TypeEntity {
    if (!name.qualifier) {
      if (name.name === '()') return UNIT_TYPE;
      if (name.name === '[]') return LIST_TYPE;
      if (name.name === '->') return FUNCTION_TYPE;
      const tuple = /^\((,+)\)$/.exec(name.name);
      if (tuple) return tupleType(tuple[1].length + 1);
    }
    const found = this.lookupType(name);
    if (found.kind !== 'type') throw compileError(name.span, `${describeName(name)} はクラスで、型ではありません。`);
    return found.entity;
  }

  private lookupClass(name: QName): ClassEntity {
    const found = this.lookupType(name);
    if (found.kind !== 'class') throw compileError(name.span, `${describeName(name)} は型で、クラスではありません。`);
    return found.entity;
  }
}

const STAR_TYPE = { tag: 'tgen', index: 0 } as const;

/** A function's clauses or a pattern binding, before renaming. */
interface RawBinding {
  kind: 'fun' | 'pat';
  names: Name[];
  clauses: { args: Pat[]; rhs: Rhs; span: Span }[];
  pattern?: Pat;
  span: Span;
  entities: ValueEntity[];
}

/** Groups adjacent clauses of the same function into one binding, as Haskell requires them to be adjacent. */
// code-gauge-allow functionCognitiveComplexity 29 -- Grouping clauses into bindings checks each of GHC's conditions on adjacent clauses.
// code-gauge-allow functionNcss 35 -- Grouping clauses into bindings checks each of GHC's conditions on adjacent clauses.
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
    default: {
      break;
    }
  }
}

/** Replaces a pattern binding's fresh variables by the ones its group declared, which other bindings refer to. */
function replacePatLocals(pat: RPat, scope: LocalScope): void {
  switch (pat.k) {
    case 'var': {
      pat.local = scope.vars.get(pat.local.name) as LocalVar;
      break;
    }
    case 'as': {
      pat.local = scope.vars.get(pat.local.name) as LocalVar;
      replacePatLocals(pat.pat, scope);
      break;
    }
    case 'con': {
      for (const arg of pat.args) replacePatLocals(arg, scope);
      break;
    }
    default: {
      break;
    }
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
    case 'con': {
      return false;
    }
    case 'app': {
      return rtypeMentions(type.fn, name) || rtypeMentions(type.arg, name);
    }
    case 'fun': {
      return rtypeMentions(type.from, name) || rtypeMentions(type.to, name);
    }
  }
}
