import { assert } from 'es-toolkit';

import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { TURTLE_METHOD_NAMES } from '../interpreter/turtleWorld';
import {
  COERCIBLE_CLASS,
  CONSTRAINT_KIND,
  DOUBLE_TYPE,
  EQUALITY_CLASS,
  HAS_FIELD_CLASS,
  INT_TYPE,
  INTEGER_TYPE,
  IO_TYPE,
  NATURAL_TYPE,
  PRIMITIVE_TYPES,
  setComparisonConstructors,
  TURTLE_TYPE,
  TYPE_KIND,
  TYPE_LIT_FAMILIES,
  UNIT_TYPE,
} from './builtinTypes';
import { ClassEnv } from './classEnv';
import { Codegen, type CodegenSupport, globalOf } from './codegen';
import type { GlobalDef } from './core';
import { DERIVABLE_CLASSES } from './deriving';
import { type ClassEntity, nextId, type TypeEntity, type ValueEntity } from './entities';
import { type Builtins, setLiteralClasses } from './infer';
import { ioSupport, setIOConstructors } from './ioPrimitives';
import {
  LIBRARY_SOURCES,
  PUBLIC_MODULES,
  TEMPLATE_HASKELL_UNSUPPORTED,
  UNSUPPORTED_MODULES,
  UNSUPPORTED_VALUES,
} from './library';
import { GHC_EXPORTS, type GhcModuleExports } from './library/ghcExports';
import { emptyExports, type ExportTable, type TypeLike } from './modules';
import { misplacedHaskellAtomicMessage, parseHaskell, parseProgram, preprocessProgram } from './parse';
import { setPrimitiveTypes } from './primitives';
import { renameModule, type RenameOptions, type RModule } from './rename';
import type { Module, Span } from './syntax';
import type { SpliceNames, SpliceSyntax } from './thDecode';
import { SPLICE_ENTRY } from './thSplice';
import { typecheckModule } from './typecheck';
import { STAR, tcon } from './types';
import { withCompilationBudget, withTypeWorkBudget } from './typeWorkBudget';

/** Compiled once per process. */
interface Library {
  modules: Map<string, ExportTable>;
  env: ClassEnv;
  builtins: Builtins;
  support: CodegenSupport;
  derivingSupport: (name: string) => ValueEntity;
  weakValues: Map<string, ValueEntity>;
  weakTypes: Map<string, TypeEntity>;
  /** A value of the library's base module, which code the compiler generates refers to. */
  value: (name: string) => ValueEntity;
}

let library: Library | undefined;

/** GHC.TypeNats' type families: those of GHC.TypeLits on naturals. */
const TYPE_LIT_FAMILIES_NATURAL = Object.fromEntries(
  Object.entries(TYPE_LIT_FAMILIES).filter(([name]) => !['CmpSymbol', 'AppendSymbol'].includes(name))
);

function primitiveExports(): ExportTable {
  const table = emptyExports();
  for (const type of PRIMITIVE_TYPES)
    table.types.set(type.name, { entity: { kind: 'type', entity: type }, children: [] });
  table.types.set('HasField', { entity: { kind: 'class', entity: HAS_FIELD_CLASS }, children: [] });
  table.types.set('Coercible', { entity: { kind: 'class', entity: COERCIBLE_CLASS }, children: [] });
  return table;
}

function compileLibrary(): Library {
  const compiler = new LibraryCompiler();
  for (const { name, source } of LIBRARY_SOURCES) compiler.compileModule(name, source);
  compiler.markPrintfResults();
  compiler.markTraceTypes();
  setLiteralClasses(compiler.baseClass('KnownNat'), compiler.baseClass('KnownSymbol'));
  for (const [key, name] of [
    ['exception', 'primException'],
    ['display', 'primDisplayException'],
    ['isExit', 'primIsExit'],
  ] as const) {
    const entity = compiler.baseValue(name);
    ioSupport[key] = globalOf(entity, entity.name, entity);
  }
  for (const [name, what] of Object.entries(UNSUPPORTED_VALUES)) compiler.baseValue(name).unsupported = what;
  for (const name of TEMPLATE_HASKELL_UNSUPPORTED) {
    compiler.supportValue(name).unsupported = `コンパイル中のプログラムを調べる Template Haskell の関数（${name}）`;
  }
  return {
    modules: compiler.publicModules(),
    env: compiler.env,
    builtins: compiler.builtins,
    support: compiler.support,
    derivingSupport: (name) => compiler.supportValue(name),
    weakValues: compiler.turtleValues(),
    weakTypes: new Map([['Turtle', TURTLE_TYPE]]),
    value: (name) => compiler.supportValue(name),
  };
}

/** The Turtle API's values, which every program sees unless it defines the names itself. */
const TURTLE_VALUE_NAMES = [
  'newTurtle',
  'newTurtleAt',
  'newTurtleWithColor',
  ...Object.values(TURTLE_METHOD_NAMES).flat(),
];

/** Compiles the library's modules in order, the first of which (Base) defines what the compiler refers to. */
class LibraryCompiler {
  readonly env = new ClassEnv();
  private readonly internal = new Map<string, ExportTable>();
  private base: RModule | undefined;
  readonly builtins = makeBuiltins(
    (name) => this.baseType(name),
    (name) => this.baseClass(name)
  );

  readonly support: CodegenSupport = {
    value: (name) => this.baseValue(name),
    boolType: () => this.baseType('Bool'),
    monad: () => this.baseClass('Monad'),
    monadFail: () => this.baseClass('MonadFail'),
    num: () => this.baseClass('Num'),
    fractional: () => this.baseClass('Fractional'),
    eq: () => this.baseClass('Eq'),
    enumClass: () => this.baseClass('Enum'),
    ratioCon: () => this.baseType('Ratio').cons[0],
  };

  /** A value code the compiler generates refers to: one of the base module, or of a later library module. */
  supportValue(name: string): ValueEntity {
    const entity = this.base?.exports.values.get(name);
    if (entity) return entity;
    for (const exports of this.internal.values()) {
      const found = exports.values.get(name);
      if (found) return found;
    }
    throw new Error(`The library has no ${name}`);
  }

  baseValue(name: string): ValueEntity {
    const entity = this.base?.exports.values.get(name);
    if (!entity) throw new Error(`The library has no ${name}`);
    return entity;
  }

  baseType(name: string): TypeEntity {
    const entry = this.base?.exports.types.get(name);
    if (entry?.entity.kind !== 'type') throw new Error(`The library has no type ${name}`);
    return entry.entity.entity;
  }

  baseClass(name: string): ClassEntity {
    let entry = this.base?.exports.types.get(name);
    // A class of a later library module, as Template Haskell's Lift, once that module is compiled.
    for (const exports of this.internal.values()) {
      if (entry?.entity.kind === 'class') break;
      entry = exports.types.get(name);
    }
    if (entry?.entity.kind !== 'class') throw new Error(`The library has no class ${name}`);
    return entry.entity.entity;
  }

  compileModule(name: string, source: string): void {
    try {
      this.compileModuleSource(name, source);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      const lines = source.split('\n');
      const detail = error.diagnostics.map(({ row, message }) => `${row + 1}: ${message}\n  ${lines[row]}`).join('\n');
      throw new Error(`The library module ${name} failed to compile:\n${detail}`);
    }
  }

  private compileModuleSource(name: string, source: string): void {
    const parsed = parseHaskell(source, name, true);
    const renamed = renameModule(parsed, {
      modules: this.internal,
      implicitPrelude: false,
      ambient: [primitiveExports()],
      ownShadowsImports: true,
    });
    if (name === 'Base') {
      this.base = renamed;
      for (const name of [
        'Down',
        'Accum',
        'AccumR',
        'FoldEndo',
        'FoldDual',
        'FoldSum',
        'FoldProduct',
        'FoldMax',
        'FoldMin',
        'FoldAny',
        'FoldAll',
        'FoldFirst',
        'TraversalIdentity',
      ])
        this.baseType(name).cons[0].isNewtype = true;
      setPrimitiveTypes(this.baseType('Bool').cons, this.baseType('Ordering').cons);
      setComparisonConstructors(this.baseType('Ordering').cons, this.baseType('Bool').cons);
      const maybe = this.baseType('Maybe').cons;
      setIOConstructors(this.baseType('Handle').cons[3], { nothing: maybe[0], just: maybe[1] });
    }
    const checked = typecheckModule(renamed, {
      env: this.env,
      builtins: this.builtins,
      isProgram: false,
      derivingSupport: (support) => this.baseValue(support),
    });
    const codegen = new Codegen({ support: this.support, isProgram: false });
    codegen.compileTopBindings(renamed.values);
    for (const instance of checked.instances) codegen.compileInstance(instance.info, instance.bindings);
    for (const binding of checked.defaults) codegen.compileDefault(binding);
    this.internal.set(name, renamed.exports);
  }

  /** `printf`'s result in IO is `IO ()`, which the instance `(a ~ ()) => PrintfType (IO a)` tells the type checker. */
  markPrintfResults(): void {
    for (const className of ['PrintfType', 'HPrintfType']) {
      const printfType = this.internal.get('Text.Printf.Internal')?.types.get(className);
      if (printfType?.entity.kind !== 'class') continue;
      for (const instance of this.env.instancesOf(printfType.entity.entity)) {
        const head = instance.head;
        if (head.tag === 'tap' && head.fn.tag === 'tcon' && head.fn.entity.name === 'IO') {
          instance.equalities = [[0, tcon(UNIT_TYPE)]];
        }
      }
    }
  }

  markTraceTypes(): void {
    const types: [string, string, NonNullable<TypeEntity['traceKind']>][] = [
      ['Base', 'Bool', 'bool'],
      ['Base', 'Ratio', 'ratio'],
      ['Base', 'Maybe', 'maybe'],
      ['Data.Map.Internal', 'Map', 'map'],
      ['Data.Set.Internal', 'Set', 'set'],
    ];
    for (const [module, name, kind] of types) {
      const type = this.internal.get(module)?.types.get(name)?.entity;
      assert(type?.kind === 'type', `Missing library trace type ${module}.${name}`);
      type.entity.traceKind = kind;
    }
  }

  publicModules(): Map<string, ExportTable> {
    const modules = new Map<string, ExportTable>();
    for (const [name, spec] of Object.entries(PUBLIC_MODULES)) {
      const source = this.internal.get(spec.from) as ExportTable;
      const exports = emptyExports();
      this.exportValues(exports, spec.from, spec.values, name);
      if (spec.overrides) this.exportValues(exports, spec.overrides.from, spec.overrides.values, name);
      for (const [typeName, children] of spec.types) exportType(exports, source, typeName, children, name);
      modules.set(name, exports);
    }
    for (const name of ['GHC.TypeLits', 'GHC.TypeNats']) {
      const table = modules.get(name) as ExportTable;
      const families = name === 'GHC.TypeLits' ? TYPE_LIT_FAMILIES : TYPE_LIT_FAMILIES_NATURAL;
      for (const [familyName, family] of Object.entries(families)) {
        table.types.set(familyName, { entity: { kind: 'type', entity: family }, children: [] });
      }
      table.types.set('Nat', { entity: { kind: 'type', entity: NATURAL_TYPE }, children: [] });
    }
    const kinds = emptyExports();
    for (const kind of [TYPE_KIND, CONSTRAINT_KIND])
      kinds.types.set(kind.name, { entity: { kind: 'type', entity: kind }, children: [] });
    modules.set('Data.Kind', kinds);
    addGhcExports(modules, (name) => this.internal.get(PUBLIC_MODULES[name]?.from ?? name));
    this.markConstructorVisibility(modules);
    return modules;
  }

  private markConstructorVisibility(modules: Map<string, ExportTable>): void {
    const exported = new Set([...modules.values()].flatMap((exports) => [...exports.values.values()]));
    for (const exports of this.internal.values()) {
      for (const entry of exports.types.values()) {
        if (entry.entity.kind !== 'type') continue;
        for (const con of entry.entity.entity.cons) {
          if (!exported.has(con.entity)) con.isLibraryPrivate = true;
        }
      }
    }
  }

  private exportValues(exports: ExportTable, from: string, names: string[], moduleName: string): void {
    const source = this.internal.get(from) as ExportTable;
    for (const valueName of names) {
      const entity = source.values.get(valueName);
      if (!entity) throw new Error(`${from} has no ${valueName} for ${moduleName}`);
      exports.values.set(valueName, entity);
    }
  }

  turtleValues(): Map<string, ValueEntity> {
    const values = new Map<string, ValueEntity>();
    for (const name of TURTLE_VALUE_NAMES) {
      const entity = this.baseValue(name);
      entity.weak = true;
      values.set(name, entity);
    }
    return values;
  }
}

function exportType(
  exports: ExportTable,
  source: ExportTable,
  typeName: string,
  children: 'all' | 'none' | string[],
  moduleName: string
): void {
  const primitive = PRIMITIVE_TYPES.find((type) => type.name === typeName);
  const entry = primitive
    ? { entity: { kind: 'type', entity: primitive } as TypeLike, children: [] }
    : typeName === 'HasField'
      ? { entity: { kind: 'class', entity: HAS_FIELD_CLASS } as TypeLike, children: [] }
      : typeName === 'Coercible'
        ? { entity: { kind: 'class', entity: COERCIBLE_CLASS } as TypeLike, children: [] }
        : source.types.get(typeName);
  if (!entry) throw new Error(`The library has no type ${typeName} for ${moduleName}`);
  const selected =
    children === 'all'
      ? entry.children
      : children === 'none'
        ? []
        : entry.children.filter((child) => children.includes(child.name));
  exports.types.set(typeName, { entity: entry.entity, children: selected });
  for (const child of selected) exports.values.set(child.name, child);
}

// code-gauge-allow functionNcss -- One lookup per built-in entity the checker needs.
function makeBuiltins(type: (name: string) => TypeEntity, cls: (name: string) => ClassEntity): Builtins {
  const standard = [
    'Eq',
    'Ord',
    'Show',
    'Read',
    'Enum',
    'Bounded',
    'Num',
    'Real',
    'Integral',
    'Fractional',
    'Floating',
    'RealFrac',
    'RealFloat',
    'Functor',
    'Monad',
    'MonadPlus',
    'MonadFail',
    'Semigroup',
    'Monoid',
    'Applicative',
    'Foldable',
    'Traversable',
    'Alternative',
  ];
  const numeric = ['Num', 'Real', 'Integral', 'Fractional', 'Floating', 'RealFrac', 'RealFloat'];
  let standardClasses: Set<ClassEntity> | undefined;
  let numericClasses: Set<ClassEntity> | undefined;
  let derivableClasses: Set<ClassEntity> | undefined;
  return {
    get bool() {
      return type('Bool');
    },
    get int() {
      return INT_TYPE;
    },
    get integer() {
      return INTEGER_TYPE;
    },
    get double() {
      return DOUBLE_TYPE;
    },
    get io() {
      return IO_TYPE;
    },
    get eq() {
      return cls('Eq');
    },
    get num() {
      return cls('Num');
    },
    get fractional() {
      return cls('Fractional');
    },
    get enum() {
      return cls('Enum');
    },
    get monad() {
      return cls('Monad');
    },
    get monadFail() {
      return cls('MonadFail');
    },
    get standardClasses() {
      standardClasses ??= new Set(standard.flatMap((name) => tryClass(cls, name)));
      return standardClasses;
    },
    get numericClasses() {
      numericClasses ??= new Set(numeric.map(cls));
      return numericClasses;
    },
    get derivableClasses() {
      if (derivableClasses) return derivableClasses;
      // Lift is Template Haskell's, whose module compiles after the base module uses this set.
      const found = new Set(DERIVABLE_CLASSES.flatMap((name) => tryClass(cls, name)));
      if (found.size === DERIVABLE_CLASSES.length) derivableClasses = found;
      return found;
    },
  };
}

function tryClass(cls: (name: string) => ClassEntity, name: string): ClassEntity[] {
  try {
    return [cls(name)];
  } catch {
    return [];
  }
}

/** Runs a splice's compiled code while the program compiles, which running programs provides. */
export type SpliceExecutor = (
  program: CompiledProgram,
  span: Span,
  names: SpliceNames
) => { result: SpliceSyntax; printed: string; printedError: string };

let spliceExecutor: SpliceExecutor | undefined;

export function setSpliceExecutor(executor: SpliceExecutor): void {
  spliceExecutor = executor;
}

export interface CompiledProgram {
  main: GlobalDef;
  /** What the program's Template Haskell splices printed while it compiled, to standard output and to standard error. */
  compileOutput?: string;
  compileErrorOutput?: string;
}

export interface CompileOptions {
  atomicRows?: ReadonlySet<number>;
  traceTypes?: boolean;
}

/** Compiles a program, throwing a `CompileError` for the errors GHC reports before running and for unsupported code. */
export function compileProgram(source: string, options: CompileOptions = {}): CompiledProgram {
  const lib = (library ??= compileLibrary());
  return withCompilationBudget(() => {
    // Splices are found in the text the C preprocessor leaves, as the program is.
    const {
      module,
      printed: compileOutput,
      printedError: compileErrorOutput,
    } = parseProgram(preprocessProgram(source), (spliceModule, pending, span, names) => {
      assert(spliceExecutor, 'No executor of Template Haskell splices is set');
      // Each splice recompiles the declarations before it, so that type work has a budget of its own: on the
      // program's, a module with many splices would run out though each declaration compiles once in GHC.
      const typeWork = new ExecutionBudget(Number.POSITIVE_INFINITY);
      const main = withTypeWorkBudget(
        (units) => typeWork.spend(units),
        () => compileModule(lib, spliceModule, { splice: { entry: SPLICE_ENTRY, pending } })
      );
      return spliceExecutor({ main }, span, names);
    });
    return {
      main: compileModule(lib, module, options),
      ...(compileOutput ? { compileOutput } : {}),
      ...(compileErrorOutput ? { compileErrorOutput } : {}),
    };
  });
}

/** Compiles a module of the program, whose entry is `main`, or a splice's code for its run. */
function compileModule(
  lib: Library,
  module: Module,
  { atomicRows, traceTypes = false, splice }: CompileOptions & { splice?: RenameOptions['splice'] }
): GlobalDef {
  const renamed = renameModule(module, {
    modules: lib.modules,
    implicitPrelude: module.extensions.gates('rename').allows('implicitPrelude'),
    unsupportedModule: (name) => (Object.hasOwn(UNSUPPORTED_MODULES, name) ? UNSUPPORTED_MODULES[name] : undefined),
    weakValues: lib.weakValues,
    weakTypes: lib.weakTypes,
    support: lib.value,
    splice,
  });
  const checked = typecheckModule(renamed, {
    env: new ClassEnv(lib.env),
    builtins: lib.builtins,
    isProgram: true,
    derivingSupport: lib.derivingSupport,
    entry: splice?.entry,
  });
  const codegen = new Codegen({ support: lib.support, atomicRows, isProgram: true, traceTypes });
  codegen.compileTopBindings(renamed.values);
  for (const instance of checked.instances)
    codegen.compileInstance(instance.info, instance.bindings, instance.sourceDefined);
  for (const binding of checked.defaults) codegen.compileDefault(binding);
  const misplaced = codegen.checkAtomicClaims();
  if (misplaced !== undefined) throw new CompileError([{ row: misplaced, message: misplacedHaskellAtomicMessage }]);
  assert(checked.main, 'The checked program has no main');
  return codegen.compileEntry(checked.main.entity, checked.main.evidence);
}

/** A module of GHC's, with its exports here and the key of each name for the GHC entity it is. */
interface GhcModule {
  name: string;
  ghc: GhcModuleExports;
  exports: ExportTable;
  values: string[];
  identity: (key: string) => string;
}

/** The library's entities for GHC's ones, and the children GHC exports with each type, by the key of the GHC entity. */
interface GhcEntities {
  values: Map<string, ValueEntity>;
  types: Map<string, TypeLike>;
  children: Map<string, Set<string>>;
}

/**
 * Gives each module what its GHC counterpart exports beyond what the library selects for it: the entity another module
 * exports for the same GHC entity, a type of the module the library takes it from, or else an entity that tells a
 * program using it that it is unavailable. A type gets the children GHC exports with it that the module exports.
 */
function addGhcExports(modules: Map<string, ExportTable>, sourceOf: (name: string) => ExportTable | undefined): void {
  const ghcModules = Object.entries(GHC_EXPORTS).map(([name, ghc]): GhcModule => {
    const exports = modules.get(name);
    assert(exports, `GHC's ${name} is not a module here`);
    const identity = (key: string): string => `${key} ${ghc.origins?.[key] ?? ''}`;
    return { name, ghc, exports, identity, values: ghc.values.split(' ').filter(Boolean) };
  });
  const entities = libraryEntities(ghcModules);
  for (const module of ghcModules) {
    addGhcValues(module, entities);
    addGhcTypes(module, entities, sourceOf(module.name));
    assertGhcExports(module);
  }
}

function libraryEntities(ghcModules: GhcModule[]): GhcEntities {
  const entities: GhcEntities = { values: new Map(), types: new Map(), children: new Map() };
  for (const { ghc, exports, identity, values } of ghcModules) {
    for (const value of values) {
      const entity = exports.values.get(value);
      const key = identity(`v:${value}`);
      if (entity && !entities.values.has(key)) entities.values.set(key, entity);
    }
    for (const [type, children] of Object.entries(ghc.types)) {
      const entry = exports.types.get(type);
      const key = identity(`t:${type}`);
      if (entry && !entities.types.has(key)) entities.types.set(key, entry.entity);
      entities.children.set(key, new Set([...(entities.children.get(key) ?? []), ...children.split(' ')]));
    }
  }
  return entities;
}

function addGhcValues({ name, ghc, exports, identity, values }: GhcModule, entities: GhcEntities): void {
  const fields = new Set(ghc.fields?.split(' '));
  for (const value of values) {
    if (exports.values.has(value)) continue;
    const key = identity(`v:${value}`);
    const entity = entities.values.get(key) ?? {
      id: nextId(),
      name: value,
      module: name,
      sort: 'var',
      unsupportedField: fields.has(value),
      unsupported: `ライブラリ関数（${name}.${value}）`,
    };
    entities.values.set(key, entity);
    exports.values.set(value, entity);
  }
}

function addGhcTypes(
  { name, ghc, exports, identity }: GhcModule,
  entities: GhcEntities,
  source: ExportTable | undefined
): void {
  for (const type of Object.keys(ghc.types)) {
    const key = identity(`t:${type}`);
    let entry = exports.types.get(type);
    if (!entry) {
      const entity: TypeLike =
        type === '~'
          ? { kind: 'class', entity: EQUALITY_CLASS }
          : (entities.types.get(key) ?? source?.types.get(type)?.entity ?? unavailableType(name, type));
      entities.types.set(key, entity);
      entry = { entity, children: [] };
      exports.types.set(type, entry);
    }
    entry.children = [...(entities.children.get(key) ?? [])].flatMap((child) => exports.values.get(child) ?? []);
    if (entry.entity.kind === 'class') {
      const cls = entry.entity.entity;
      cls.exportedMethods = [...new Set([...(cls.exportedMethods ?? []), ...entry.children])];
    }
  }
}

function assertGhcExports({ name, ghc, exports, values }: GhcModule): void {
  const exported = new Set(values);
  for (const value of exports.values.keys()) assert(exported.has(value), `GHC's ${name} does not export ${value}`);
  for (const type of exports.types.keys())
    assert(Object.hasOwn(ghc.types, type), `GHC's ${name} does not export ${type}`);
}

function unavailableType(module: string, name: string): TypeLike {
  const entity: TypeEntity = {
    id: nextId(),
    name,
    module,
    sort: 'prim',
    kind: STAR,
    arity: 0,
    cons: [],
    fields: new Map(),
    unsupported: `ライブラリの型（${module}.${name}）`,
  };
  return { kind: 'type', entity };
}
