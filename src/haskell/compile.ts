import { CompileError } from '../interpreter/diagnostics';
import { TURTLE_METHOD_NAMES } from '../interpreter/turtleWorld';
import { PRIMITIVE_TYPES, TURTLE_TYPE, UNIT_TYPE } from './builtinTypes';
import { ClassEnv } from './classEnv';
import { Codegen, type CodegenSupport, globalOf } from './codegen';
import type { GlobalDef } from './core';
import type { ClassEntity, ConInfo, TypeEntity, ValueEntity } from './entities';
import { compileError } from './errors';
import type { Builtins } from './infer';
import { LIBRARY_SOURCES, PUBLIC_MODULES, UNSUPPORTED_MODULES, UNSUPPORTED_VALUES } from './library';
import { type CompiledModuleInfo, emptyExports, type ExportTable, type TypeLike } from './modules';
import { misplacedHaskellAtomicMessage, parseHaskell } from './parse';
import { setPrimitiveTypes } from './primitives';
import { renameModule, type RModule } from './rename';
import { typecheckModule } from './typecheck';
import { tcon } from './types';

/** The library compiled once per process: its modules, instances, and the entities the compiler refers to. */
interface Library {
  modules: Map<string, CompiledModuleInfo>;
  env: ClassEnv;
  builtins: Builtins;
  support: CodegenSupport;
  derivingSupport: (name: string) => ValueEntity;
  weakValues: Map<string, ValueEntity>;
  weakTypes: Map<string, TypeEntity>;
  negate: () => ValueEntity;
}

let library: Library | undefined;

/** Compiles the library on first use; its modules are the same for every run. */
export function getLibrary(): Library {
  library ??= compileLibrary();
  return library;
}

function primitiveExports(): ExportTable {
  const table = emptyExports();
  for (const type of PRIMITIVE_TYPES)
    table.types.set(type.name, { entity: { kind: 'type', entity: type }, children: [] });
  return table;
}

function compileLibrary(): Library {
  const compiler = new LibraryCompiler();
  for (const { name, source } of LIBRARY_SOURCES) compiler.compileModule(name, source);
  compiler.markPrintfResults();
  for (const [name, what] of Object.entries(UNSUPPORTED_VALUES)) compiler.baseValue(name).unsupported = what;
  return {
    modules: compiler.publicModules(),
    env: compiler.env,
    builtins: compiler.builtins,
    support: compiler.support,
    derivingSupport: (name) => compiler.baseValue(name),
    weakValues: compiler.turtleValues(),
    weakTypes: new Map([['Turtle', TURTLE_TYPE]]),
    negate: () => compiler.baseValue('negate'),
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
  private readonly internal = new Map<string, CompiledModuleInfo>();
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
    const entry = this.base?.exports.types.get(name);
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
      setPrimitiveTypes(this.baseType('Bool').cons, this.baseType('Ordering').cons);
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
    this.internal.set(name, {
      name,
      exports: renamed.exports,
      instances: checked.instances.map((instance) => instance.info),
    });
  }

  /** `printf`'s result in IO is `IO ()`, which the instance `(a ~ ()) => PrintfType (IO a)` tells the type checker. */
  markPrintfResults(): void {
    for (const className of ['PrintfType', 'HPrintfType']) {
      const printfType = this.internal.get('Text.Printf.Internal')?.exports.types.get(className);
      if (printfType?.entity.kind !== 'class') continue;
      for (const instance of this.env.instancesOf(printfType.entity.entity)) {
        const head = instance.head;
        if (head.tag === 'tap' && head.fn.tag === 'tcon' && head.fn.entity.name === 'IO') {
          instance.equalities = [[0, tcon(UNIT_TYPE)]];
        }
      }
    }
  }

  /** The modules a program may import, each re-exporting part of a library module. */
  publicModules(): Map<string, CompiledModuleInfo> {
    const modules = new Map<string, CompiledModuleInfo>();
    for (const [name, spec] of Object.entries(PUBLIC_MODULES)) {
      const source = this.internal.get(spec.from) as CompiledModuleInfo;
      const exports = emptyExports();
      for (const valueName of spec.values) {
        const entity = source.exports.values.get(valueName);
        if (!entity) throw new Error(`${spec.from} has no ${valueName} for ${name}`);
        exports.values.set(valueName, entity);
      }
      if (spec.overrides) {
        const overrides = this.internal.get(spec.overrides.from) as CompiledModuleInfo;
        for (const valueName of spec.overrides.values) {
          const entity = overrides.exports.values.get(valueName);
          if (!entity) throw new Error(`${spec.overrides.from} has no ${valueName} for ${name}`);
          exports.values.set(valueName, entity);
        }
      }
      for (const [typeName, children] of spec.types) exportType(exports, source, typeName, children, name);
      modules.set(name, { name, exports, instances: [] });
    }
    return modules;
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
  source: CompiledModuleInfo,
  typeName: string,
  children: 'all' | 'none' | string[],
  moduleName: string
): void {
  const primitive = PRIMITIVE_TYPES.find((type) => type.name === typeName);
  const entry = primitive
    ? { entity: { kind: 'type', entity: primitive } as TypeLike, children: [] }
    : source.exports.types.get(typeName);
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

// code-gauge-allow functionNcss 34 -- One lookup per built-in entity the checker needs.
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
  return {
    get bool() {
      return type('Bool');
    },
    get int() {
      return PRIMITIVE_TYPES[0];
    },
    get integer() {
      return PRIMITIVE_TYPES[1];
    },
    get double() {
      return PRIMITIVE_TYPES[2];
    },
    get io() {
      return PRIMITIVE_TYPES[5];
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
  };
}

function tryClass(cls: (name: string) => ClassEntity, name: string): ClassEntity[] {
  try {
    return [cls(name)];
  } catch {
    return [];
  }
}

export interface CompiledProgram {
  main: GlobalDef;
}

/** Compiles a program, throwing a `CompileError` for the errors GHC reports before running and for unsupported code. */
export function compileProgram(source: string, atomicRows?: ReadonlySet<number>): CompiledProgram {
  const lib = getLibrary();
  const parsed = parseHaskell(source);
  if (parsed.name !== 'Main') {
    throw compileError(0, `モジュール名は Main にしてください（${parsed.name} になっています）。`);
  }
  const renamed = renameModule(parsed, {
    modules: lib.modules,
    implicitPrelude: true,
    unsupportedModule: (name) => (Object.hasOwn(UNSUPPORTED_MODULES, name) ? UNSUPPORTED_MODULES[name] : undefined),
    weakValues: lib.weakValues,
    weakTypes: lib.weakTypes,
    negate: lib.negate,
  });
  const checked = typecheckModule(renamed, {
    env: new ClassEnv(lib.env),
    builtins: lib.builtins,
    isProgram: true,
    derivingSupport: lib.derivingSupport,
  });
  const codegen = new Codegen({ support: lib.support, atomicRows, isProgram: true });
  codegen.compileTopBindings(renamed.values);
  for (const instance of checked.instances) codegen.compileInstance(instance.info, instance.bindings);
  for (const binding of checked.defaults) codegen.compileDefault(binding);
  const misplaced = codegen.checkAtomicClaims();
  if (misplaced !== undefined) throw new CompileError([{ row: misplaced, message: misplacedHaskellAtomicMessage }]);
  const main = renamed.exports.values.get('main') ?? findMain(renamed);
  return { main: globalOf(main, 'main', main) };
}

function findMain(module: RModule): ValueEntity {
  for (const binding of module.values.bindings) {
    if (binding.k === 'fun' && binding.binder.kind === 'global' && binding.binder.entity.name === 'main') {
      return binding.binder.entity;
    }
  }
  throw compileError(0, 'main が定義されていません。');
}

export type { ConInfo };
