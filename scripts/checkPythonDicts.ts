// Compares the class `__dict__`s and the module namespaces of this grader with CPython's (3.14.10), and prints the
// lines that differ (`<` CPython, `>` this grader) and their count:
//   bun scripts/checkPythonDicts.ts [module ...] [--write]
// With --write, it writes the modules and classes that still differ to src/python/data/namespaceDifferences.ts, whose
// namespaces this grader then refuses to list (see src/python/namespaceDifferences.ts).
// For each builtin type, internal type (iterators, views, descriptors, code, frame, ...) and public class of the
// supported modules, the program it runs prints the type and the keys of `vars(T)` in order; for each module, the keys of
// `vars(module)` in order, with the `__module__` of each function and class. Each module is imported in a process of its
// own, as other imports would add their submodules to its namespace. The attributes this grader leaves unsupported,
// such as a module's `__file__`, are left out of both sides.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Runtime as RuntimeType } from '../src/python/runtime';

const REF = path.join(os.homedir(), 'Documents/tokyo-online-university/step-interpreter/scripts/ref');

/** Values of the types that no module names, whose classes the program compares too. */
const SAMPLES = `
def _function(): pass
async def _coroutine(): pass
async def _async_generator(): yield
def _generator(): yield
def _cell():
    x = 0
    return (lambda: x).__closure__[0]
class _Slots:
    __slots__ = ('a',)
_coro = _coroutine()
_agen = _async_generator()
SAMPLES = [iter([]), iter(()), iter(''), iter({}), iter(set()), iter(range(1)), iter(range(2 ** 70)), reversed([]),
           reversed(range(1)), reversed({}), reversed({}.keys()), {}.keys(), {}.values(), {}.items(), iter({}.keys()),
           iter({}.values()), iter({}.items()), reversed({}.values()), reversed({}.items()), iter(b''),
           iter(bytearray()), iter(lambda: 0, 0), iter(memoryview(b'')), _generator(), _coro, _agen, _agen.asend(None),
           _agen.athrow(ValueError), _coro.__await__(), _cell(), _function.__code__, sys._getframe(), len, [].append,
           list.append, int.__add__, (1).__add__, int.__dict__['real'], int.__dict__['from_bytes'],
           _Slots.__dict__['a'], type.__dict__, types.SimpleNamespace(), list[int], int | str, _function.__get__(1),
           sys.flags, sys.float_info, sys.int_info, sys.version_info, sys.hash_info, sys.thread_info,
           property(), staticmethod(len), classmethod(len), super(int, 1), NotImplemented, Ellipsis, None,
           types.TracebackType, types.ModuleType('m'), memoryview(b''), slice(1), range(1), object(), enumerate([]),
           zip(), map(len, []), filter(None, []), _Slots, BaseExceptionGroup('m', [ValueError()])]
_coro.close()
`;

const PROGRAM = (modules: readonly string[], types: boolean): string => `import sys, types, builtins
MODULES = ${JSON.stringify(modules)}
${SAMPLES}

def emit(line):
    print('|' + line)

def owner(value):
    if isinstance(value, (type, types.FunctionType, types.BuiltinFunctionType)):
        return ' ' + str(value.__module__)
    return ''

def type_name(cls):
    return str(cls.__module__) + '.' + cls.__qualname__

def collect_types(found, classes):
    pending = list(classes)
    while pending:
        cls = pending.pop()
        if cls in found:
            continue
        found.append(cls)
        for value in list(cls.__dict__.values()):
            if isinstance(value, type):
                pending.append(value)
            elif type(value).__module__ == 'builtins':
                pending.append(type(value))

modules = []
for name in MODULES:
    __import__(name)
    modules.append(sys.modules[name])
for module in modules:
    for key, value in list(vars(module).items()):
        emit('M ' + module.__name__ + ' ' + key + owner(value))
if ${types ? 'True' : 'False'}:
    classes = [value for value in vars(builtins).values() if isinstance(value, type)]
    classes += [type(value) for value in SAMPLES]
    for module in modules + [types]:
        classes += [value for key, value in vars(module).items() if isinstance(value, type) and not key.startswith('_')]
    found = []
    collect_types(found, classes)
    entries = {}
    for cls in found:
        # The importer of CPython's builtins module is what this grader leaves unsupported.
        if cls.__module__ not in ('__main__', '_frozen_importlib'):
            entries.setdefault(type_name(cls), list(cls.__dict__))
    for name in sorted(entries):
        for key in entries[name]:
            emit('T ' + name + ' ' + key)
    for cls in found:
        emit('B ' + type_name(cls) + ' ' + ' '.join(type_name(base) for base in cls.__mro__[1:]))
`;

/** Names that this grader adds on purpose, which CPython lacks. */
const GRADER_EXTENSIONS = ['M builtins Turtle'];

/** The parts of the interpreter the script uses, loaded once the class orders are set. */
const interpreter = {} as {
  parsePython: (source: string) => unknown;
  runModule: (runtime: RuntimeType, module: never) => { output: string; uncaughtException?: string };
  Runtime: new () => RuntimeType;
  registeredUnsupportedNames: (name: string) => string[];
  supportedModules: ReadonlySet<string>;
};

if (import.meta.main) {
  // The orders this grader gives classes are set as the interpreter loads, so a natural order needs a run of its own.
  const { applyClassOrders } = await import('../src/python/classOrders');
  applyClassOrders(!process.argv.includes('--natural'));
  await loadInterpreter();
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const modules =
    requested.length > 0 ? requested : [...interpreter.supportedModules].filter((name) => name !== '__main__');
  mkdirSync('.tmp/pythonDicts', { recursive: true });
  if (process.argv.includes('--natural')) {
    // The classes' names in the order this grader creates them, for the parent run.
    process.stdout.write(runOurs(PROGRAM(modules, true)).output);
  } else {
    compare(modules);
  }
}

async function loadInterpreter(): Promise<void> {
  const { LIMITS } = await import('../src/interpreter/limits');
  // The type program prints far more than a learner's program may.
  Object.assign(LIMITS, { maxOperations: 1e9, maxMilliseconds: 1e6, maxSlots: 1e9, maxOutputLength: 1e9 });
  const { parsePython } = await import('../src/python/parse');
  const { runModule } = await import('../src/python/run');
  const { Runtime } = await import('../src/python/runtime');
  const { registeredUnsupportedNames } = await import('../src/python/unsupportedAttributes');
  const { enforceNamespaceDifferences } = await import('../src/python/namespaceDifferences');
  // The namespaces this grader makes loud are what the script compares.
  enforceNamespaceDifferences(false);
  const { SUPPORTED_MODULES } = await import('../src/python/moduleNames');
  Object.assign(interpreter, {
    parsePython,
    runModule,
    Runtime,
    registeredUnsupportedNames,
    supportedModules: SUPPORTED_MODULES,
  });
}

function compare(modules: string[]): void {
  const python = pythonExecutable();
  const lines: Lines = { reference: [], ours: [], natural: [], allowed: new Set(GRADER_EXTENSIONS) };
  compareModules(python, modules, lines);
  compareTypes(python, modules, lines);
  const keep = (line: string): boolean => !lines.allowed.has(line.split(' ').slice(0, 3).join(' '));
  const [reference, ours] = [lines.reference.filter(keep), lines.ours.filter(keep)];
  const differences = {
    modules: differing(reference, ours, 'M'),
    classes: withoutInherited(differing(reference, ours, 'T'), lines.reference),
  };
  for (const [kind, entries] of Object.entries(differences)) {
    for (const [name, [missing, extra]] of Object.entries(entries)) {
      const order = missing.length + extra.length === 0 ? ' (order only)' : '';
      console.log(`${kind} ${name}${order}: missing ${missing.join(' ')}; extra ${extra.join(' ')}`);
    }
  }
  console.log(`differing lines: ${countDiffLines(reference, ours)}`);
  console.log(
    `differing modules: ${Object.keys(differences.modules).length}, classes: ${Object.keys(differences.classes).length}`
  );
  if (process.argv.includes('--write'))
    writeTable(differences, classOrders(lines.reference, lines.natural.filter(keep)));
}

/**
 * Leaves out of each class's extra names those CPython's class has from a base, which reading finds in CPython too:
 * the extra names are those that reading must refuse.
 */
function withoutInherited(entries: Record<string, Difference>, reference: string[]): Record<string, Difference> {
  const names = namesBy(reference, 'T');
  const bases = new Map(
    reference
      .filter((line) => line.startsWith('B '))
      .map((line) => {
        const [, name, ...rest] = line.split(' ');
        return [name as string, rest] as const;
      })
  );
  const result: Record<string, Difference> = {};
  for (const [name, [missing, extra]] of Object.entries(entries)) {
    const inherited = new Set((bases.get(name) ?? []).flatMap((base) => names.get(base) ?? []));
    result[name] = [missing, extra.filter((key) => !inherited.has(key))];
  }
  return result;
}

/** The CPython order of each class whose order this grader's creation does not give, by its natural order. */
function classOrders(reference: string[], natural: string[]): Record<string, string> {
  const [left, right] = [namesBy(reference, 'T'), namesBy(natural, 'T')];
  const orders: Record<string, string> = {};
  for (const [name, expected] of left) {
    const actual = right.get(name);
    if (actual === undefined) continue;
    const present = expected.filter((key) => actual.includes(key));
    if (present.join(' ') !== actual.filter((key) => expected.includes(key)).join(' ')) {
      orders[name] = expected.join(' ');
    }
  }
  return orders;
}

type Difference = [missing: string[], extra: string[]];

/** The entries (modules or classes) whose names differ in set or order, with the names one side lacks. */
function differing(reference: string[], ours: string[], kind: 'M' | 'T'): Record<string, Difference> {
  const [left, right] = [namesBy(reference, kind), namesBy(ours, kind)];
  const result: Record<string, Difference> = {};
  for (const [name, expected] of left) {
    const actual = right.get(name) ?? [];
    if (expected.join(' ') === actual.join(' ')) continue;
    const [expectedKeys, actualKeys] = [keys(expected), keys(actual)];
    result[name] = [
      expectedKeys.filter((key) => !actualKeys.includes(key)),
      actualKeys.filter((key) => !expectedKeys.includes(key)),
    ];
  }
  for (const [name, actual] of right) {
    if (!left.has(name)) result[name] = [[], actual.map((entry) => entry.split(' ')[0] as string)];
  }
  return result;
}

/** Each module's or class's names in order, with a function's module after its name for a module. */
function namesBy(lines: string[], kind: 'M' | 'T'): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of lines) {
    const [lineKind, name, ...rest] = line.split(' ');
    if (lineKind !== kind) continue;
    result.set(name as string, [...(result.get(name as string) ?? []), rest.join(' ')]);
  }
  return result;
}

/** The lines `diff` finds differing, with each class's names sorted, as the counts so far compared them. */
function countDiffLines(reference: string[], ours: string[]): number {
  writeFileSync('.tmp/pythonDicts/cpython.txt', `${sorted(reference).join('\n')}\n`);
  writeFileSync('.tmp/pythonDicts/ours.txt', `${sorted(ours).join('\n')}\n`);
  const diff = spawnSync('diff', ['.tmp/pythonDicts/cpython.txt', '.tmp/pythonDicts/ours.txt'], { encoding: 'utf8' });
  return diff.stdout.split('\n').filter((line) => /^[<>] /.test(line)).length;
}

function writeTable(
  differences: Record<'modules' | 'classes', Record<string, Difference>>,
  orders: Record<string, string>
): void {
  writeFileSync(
    'src/python/data/namespaceDifferences.ts',
    `// Generated by \`bun scripts/checkPythonDicts.ts --write\` from CPython 3.14.10; do not edit.
import type { NamespaceDifferences } from '../namespaceDifferences';

/** The order of the namespaces of the classes whose order this grader's creation of them does not give. */
export const CLASS_ORDERS: Readonly<Record<string, string>> = ${JSON.stringify(orders)};

/** The modules and classes whose namespaces differ from CPython's, with the names CPython's has and the extra ones. */
export const NAMESPACE_DIFFERENCES: NamespaceDifferences = ${JSON.stringify(differences)};
`
  );
}

interface Lines {
  reference: string[];
  ours: string[];
  /** Our classes' names in the order this grader creates them, before it orders them as CPython's. */
  natural: string[];
  /** The lines, by their first three words, that name what this grader leaves unsupported. */
  allowed: Set<string>;
}

/** Compares each module's namespace, importing the module alone. */
function compareModules(python: string, modules: string[], lines: Lines): void {
  for (const [index, module] of modules.entries()) {
    const program = PROGRAM([module], false);
    lines.reference.push(...probeLines(runCPython(python, program)));
    const run = runOurs(program, module);
    lines.ours.push(...probeLines(run.output));
    for (const key of run.unsupported) lines.allowed.add(`M ${module} ${key}`);
    if ((index + 1) % 50 === 0) console.error(`${index + 1}/${modules.length}`);
  }
}

/** Compares the namespaces of the classes both CPython and this grader reach, importing every module. */
function compareTypes(python: string, modules: string[], lines: Lines): void {
  const typeProgram = PROGRAM(modules, true);
  const ourTypes = probeLines(runOurs(typeProgram).output).filter((line) => line.startsWith('T '));
  const referenceLines = probeLines(runCPython(python, typeProgram));
  const referenceTypes = referenceLines.filter((line) => line.startsWith('T '));
  // A class only one side reaches is a name a module lacks, which the module's lines show.
  const [ourTypeNames, referenceTypeNames] = [typeNames(ourTypes), typeNames(referenceTypes)];
  lines.reference.push(...referenceTypes.filter((line) => shared(line, ourTypeNames)));
  lines.reference.push(...referenceLines.filter((line) => line.startsWith('B ')));
  lines.ours.push(...ourTypes.filter((line) => shared(line, referenceTypeNames)));
  const natural = spawnSync('bun', [process.argv[1] as string, '--natural', ...modules], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  lines.natural.push(...probeLines(natural.stdout).filter((line) => line.startsWith('T ')));
  for (const name of ourTypeNames) {
    // The class attributes this grader leaves unsupported, which raise the unsupported error.
    for (const key of interpreter.registeredUnsupportedNames(name)) lines.allowed.add(`T ${name} ${key}`);
  }
}

function typeNames(lines: string[]): Set<string> {
  return new Set(lines.map((line) => line.split(' ')[1] as string));
}

function keys(list: string[]): string[] {
  return list.map((entry) => entry.split(' ')[0] as string);
}

function sorted(list: string[]): string[] {
  return [...list.filter((line) => line.startsWith('M ')), ...list.filter((line) => line.startsWith('T ')).toSorted()];
}

function shared(line: string, names: Set<string>): boolean {
  return names.has(line.split(' ')[1] as string);
}

function pythonExecutable(): string {
  writeFileSync('.tmp/pythonDicts/executable.py', 'import sys\nprint(sys.executable)\n');
  return spawnSync(REF, ['python', '.tmp/pythonDicts/executable.py'], { encoding: 'utf8' }).stdout.trim();
}

function runCPython(python: string, program: string): string {
  const result = spawnSync(python, ['-I', '-W', 'ignore', '-c', program], { encoding: 'utf8' });
  if (result.status !== 0) console.error(`CPython: ${result.stderr.trim().split('\n').at(-1)}`);
  return result.stdout;
}

/** Runs the program in this grader, returning its output and the attributes the module leaves unsupported. */
function runOurs(program: string, module?: string): { output: string; unsupported: string[] } {
  const runtime = new interpreter.Runtime();
  const unsupported: string[] = [];
  try {
    const run = interpreter.runModule(runtime, interpreter.parsePython(program) as never);
    if (run.uncaughtException) console.error(`${module ?? 'types'}: ${run.uncaughtException.split('\n').at(-1)}`);
    const value = (
      runtime as unknown as { modules: Map<string, { unsupported: Map<string, string>; imports: Map<string, string> }> }
    ).modules.get(module ?? '');
    unsupported.push(...(value?.unsupported.keys() ?? []), ...(value?.imports.keys() ?? []));
    return { output: run.output, unsupported };
  } catch (error) {
    console.error(`${module ?? 'types'}: ${String(error)}`);
    return { output: '', unsupported };
  }
}

function probeLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1));
}
