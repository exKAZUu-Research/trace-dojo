import { CompileError } from '../interpreter/diagnostics';
import type { KotlinFile } from './ast';
import { type CompiledProgram, type CompileOptions, Compiler } from './compiler';
import { compileError, type Core, PackageScope } from './compilerBase';
import { setDispatchCore } from './dispatch';
import { setAnyMembers } from './format';
import './natives';
import { nativeFunctions, nativeProperties, setLibraryClasses } from './natives/registry';
import { parseKotlin } from './parse';
import { PRELUDE_SOURCES } from './prelude';
import { EXCEPTIONS } from './prelude/runtimeTypes';
import type { ExceptionFactory, Frame } from './runtime';
import type { ClassSymbol, FunctionSymbol } from './symbols';
import { setCoreClasses } from './typeRelations';
import type { KObject, PrimitiveKind } from './values';

/** The standard library, compiled once per process, which every program's compilation starts from. */
export interface Library {
  packages: Map<string, PackageScope>;
  core: Core;
  globalCount: number;
  initializers: CompiledProgram['initializers'];
  exceptions: ExceptionFactory;
}

/** The binary names of the JVM for the library's classes that Kotlin maps to Java's. */
const JVM_NAMES: Record<string, string> = {
  'kotlin.Any': 'java.lang.Object',
  'kotlin.String': 'java.lang.String',
  'kotlin.CharSequence': 'java.lang.CharSequence',
  'kotlin.Int': 'java.lang.Integer',
  'kotlin.Long': 'java.lang.Long',
  'kotlin.Short': 'java.lang.Short',
  'kotlin.Byte': 'java.lang.Byte',
  'kotlin.Double': 'java.lang.Double',
  'kotlin.Float': 'java.lang.Float',
  'kotlin.Char': 'java.lang.Character',
  'kotlin.Boolean': 'java.lang.Boolean',
  'kotlin.Number': 'java.lang.Number',
  'kotlin.Comparable': 'java.lang.Comparable',
  'kotlin.Throwable': 'java.lang.Throwable',
  'kotlin.Enum': 'java.lang.Enum',
  'kotlin.Array': '[Ljava.lang.Object;',
  'kotlin.collections.Iterable': 'java.lang.Iterable',
  'kotlin.collections.Collection': 'java.util.Collection',
  'kotlin.collections.List': 'java.util.List',
  'kotlin.collections.MutableList': 'java.util.List',
  'kotlin.collections.Set': 'java.util.Set',
  'kotlin.collections.MutableSet': 'java.util.Set',
  'kotlin.collections.Map': 'java.util.Map',
  'kotlin.collections.MutableMap': 'java.util.Map',
  'kotlin.collections.Iterator': 'java.util.Iterator',
  'kotlin.collections.ArrayList': 'java.util.ArrayList',
  'kotlin.collections.HashMap': 'java.util.HashMap',
  'kotlin.collections.LinkedHashMap': 'java.util.LinkedHashMap',
  'kotlin.collections.HashSet': 'java.util.HashSet',
  'kotlin.collections.LinkedHashSet': 'java.util.LinkedHashSet',
  'kotlin.text.StringBuilder': 'java.lang.StringBuilder',
  'tracedojo.Turtle': 'Turtle',
};

let cached: Library | undefined;

/** The standard library's prelude, parsed and compiled the first time a program needs it. */
export function getLibrary(): Library {
  cached ??= loadLibrary();
  return cached;
}

function loadLibrary(): Library {
  const packages = new Map<string, PackageScope>();
  const compiler = new Compiler(packages, undefined, { functions: nativeFunctions, properties: nativeProperties });
  const files = PRELUDE_SOURCES.map((source) => ({ file: parseKotlin(source, true), isLibrary: true }));
  try {
    return compileLibrary(packages, compiler, files);
  } catch (error) {
    // A mistake in the prelude is the interpreter's, which must not look like an error in the learner's program.
    if (error instanceof CompileError) {
      const [diagnostic] = error.diagnostics;
      const lines = PRELUDE_SOURCES.map(
        (source, index) => `#${index}: ${source.split('\n')[diagnostic.row]?.trim() ?? ''}`
      );
      throw new TypeError(`The prelude does not compile: ${error.message}\n${lines.join('\n')}`);
    }
    throw error;
  }
}

function compileLibrary(
  packages: Map<string, PackageScope>,
  compiler: Compiler,
  files: { file: KotlinFile; isLibrary: boolean }[]
): Library {
  let core: Core | undefined;
  const classes = new Map<string, ClassSymbol>();
  const { initializers } = compiler.compileFiles(
    files,
    () => {
      for (const scope of packages.values()) for (const cls of scope.classes.values()) collectClasses(cls, classes);
      for (const [name, cls] of classes) {
        const jvmName = JVM_NAMES[name];
        if (jvmName) cls.qualifiedName = jvmName;
      }
      for (const [packageName, name, , jvmName] of EXCEPTIONS) {
        const cls = classes.get(`${packageName}.${name}`);
        if (cls) cls.qualifiedName = jvmName;
      }
      core = buildCore(classes);
      compiler.setCore(core);
      setCoreClasses({ any: core.any, function: core.function });
      setDispatchCore(core);
      setLibraryClasses(classes);
    },
    () => {
      const anyClass = (core as Core).any;
      const member = (name: string): FunctionSymbol => anyClass.members.get(name)?.[0] as FunctionSymbol;
      setAnyMembers({ toString: member('toString'), equals: member('equals'), hashCode: member('hashCode') });
    }
  );
  if (compiler.missingNatives.length > 0)
    throw new Error(`The prelude lacks natives: ${compiler.missingNatives.join(', ')}`);
  const byJvmName = new Map<string, ClassSymbol>();
  for (const cls of classes.values()) byJvmName.set(cls.qualifiedName, cls);
  return {
    packages,
    core: core as Core,
    globalCount: compiler.globals,
    initializers,
    exceptions: {
      create: (frame: Frame, qualifiedName: string, message: string | undefined): KObject => {
        const cls = byJvmName.get(qualifiedName);
        if (!cls) throw new Error(`The library has no exception ${qualifiedName}`);
        const ctor = cls.constructors.find(
          (candidate) => candidate.params.length === 1 && candidate.params[0].name === 'message'
        );
        if (!ctor?.invoke) throw new Error(`The exception ${qualifiedName} has no constructor of a message`);
        return ctor.invoke(frame, undefined, [message], undefined) as KObject;
      },
    },
  };
}

function collectClasses(cls: ClassSymbol, into: Map<string, ClassSymbol>): void {
  into.set(cls.kotlinName, cls);
  for (const nested of cls.nested.values()) collectClasses(nested, into);
}

const PRIMITIVE_KINDS: PrimitiveKind[] = [
  'Int',
  'Long',
  'Short',
  'Byte',
  'Double',
  'Float',
  'Char',
  'UInt',
  'ULong',
  'UShort',
  'UByte',
];

function buildCore(classes: Map<string, ClassSymbol>): Core {
  const find = (name: string): ClassSymbol => {
    const cls = classes.get(name);
    if (!cls) throw new Error(`The prelude has no class ${name}`);
    return cls;
  };
  const primitiveClasses = Object.fromEntries(PRIMITIVE_KINDS.map((kind) => [kind, find(`kotlin.${kind}`)])) as Record<
    PrimitiveKind,
    ClassSymbol
  >;
  return {
    any: find('kotlin.Any'),
    unit: find('kotlin.Unit'),
    boolean: find('kotlin.Boolean'),
    string: find('kotlin.String'),
    charSequence: find('kotlin.CharSequence'),
    number: find('kotlin.Number'),
    comparable: find('kotlin.Comparable'),
    throwable: find('kotlin.Throwable'),
    array: find('kotlin.Array'),
    iterable: find('kotlin.collections.Iterable'),
    iterator: find('kotlin.collections.Iterator'),
    collection: find('kotlin.collections.Collection'),
    list: find('kotlin.collections.List'),
    mutableList: find('kotlin.collections.MutableList'),
    set: find('kotlin.collections.Set'),
    mutableSet: find('kotlin.collections.MutableSet'),
    map: find('kotlin.collections.Map'),
    mutableMap: find('kotlin.collections.MutableMap'),
    function: find('kotlin.Function'),
    enum: find('kotlin.Enum'),
    intRange: find('kotlin.ranges.IntRange'),
    longRange: find('kotlin.ranges.LongRange'),
    charRange: find('kotlin.ranges.CharRange'),
    kProperty: find('kotlin.reflect.KProperty'),
    turtle: find('tracedojo.Turtle'),
    primitives: new Map(PRIMITIVE_KINDS.map((kind) => [primitiveClasses[kind], kind])),
    primitiveClasses,
  };
}

/** Compiles a learner's program against the library, throwing a `CompileError` for what Kotlin's compiler rejects. */
export function compileKotlin(file: KotlinFile, options: CompileOptions = {}): CompiledProgram {
  const library = getLibrary();
  const packages = new Map(library.packages);
  const packageName = file.packageName ?? '';
  const shared = packages.get(packageName);
  // The program's own package gets a scope of its own, so that its declarations never reach the shared library.
  const own = new PackageScope();
  if (shared) {
    for (const [name, cls] of shared.classes) own.classes.set(name, cls);
    for (const [name, functions] of shared.functions) own.functions.set(name, [...functions]);
    for (const [name, properties] of shared.properties) own.properties.set(name, [...properties]);
  }
  packages.set(packageName, own);
  const compiler = new Compiler(packages, library.core);
  compiler.setGlobalStart(library.globalCount);
  const { contexts, initializers } = compiler.compileFiles(
    [{ file, isLibrary: false }],
    () => {},
    () => {},
    options
  );
  const [context] = contexts;
  const main = compiler.findMain(context);
  if (!main) throw compileError(0, 'main 関数がありません。fun main() { ... } を書いてください。');
  return {
    main,
    mainTakesArgs: main.params.length === 1,
    initializers: [...library.initializers, ...initializers],
    globalCount: compiler.globals,
    ...compiler.shownDeclarations(context),
  };
}

export function libraryExceptions(): ExceptionFactory {
  return getLibrary().exceptions;
}
