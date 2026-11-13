// Compares the class `__dict__`s and the module namespaces of this grader with CPython's (3.14.10):
//   bun scripts/checkPythonDicts.ts [module ...]
//   bun scripts/checkPythonDicts.ts --write
// It prints each module and class whose names differ in set or order, as `missing ...; extra ...`, then the number of
// differing lines and of differing modules and classes. The lines compared, each class's names sorted, go to
// .tmp/pythonDicts/cpython.txt and .tmp/pythonDicts/ours.txt, which `diff` shows as `<` and `>` lines.
// With --write, which compares every supported module, it writes the modules and classes that still differ to
// src/python/data/namespaceDifferences.ts, whose namespaces this grader then refuses to list (see
// src/python/namespaceDifferences.ts).
// For each builtin type, internal type (iterators, views, descriptors, code, frame, ...) and public class of the
// supported modules, the program it runs prints the type and the keys of `vars(T)` in order; for each module, the keys of
// `vars(module)` in order, with the `__module__` of each function and class. Each module is imported in a process of its
// own, as other imports would add their submodules to its namespace. The attributes this grader leaves unsupported,
// such as a module's `__file__`, are left out of both sides.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

import { iteratorSamples } from '../src/python/iteratorTypes';
import type { parsePython as ParsePython } from '../src/python/parse';
import type { runModule as RunModule } from '../src/python/run';
import type { Runtime as RuntimeType } from '../src/python/runtime';

const EXPECTED_PYTHON = '3.14.10';

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
SAMPLES = [${iteratorSamples.join(', ')}, {}.keys(), {}.values(), {}.items(), _generator(), _coro, _agen, _agen.asend(None),
           _agen.athrow(ValueError), _coro.__await__(), _cell(), _function.__code__, sys._getframe(), len, [].append,
           list.append, int.__add__, (1).__add__, int.__dict__['real'], int.__dict__['from_bytes'],
           _Slots.__dict__['a'], type.__dict__, types.SimpleNamespace(), list[int], int | str, _function.__get__(1),
           sys.flags, sys.float_info, sys.int_info, sys.version_info, sys.hash_info, sys.thread_info,
           property(), staticmethod(len), classmethod(len), super(int, 1), NotImplemented, Ellipsis, None,
           types.TracebackType, types.ModuleType('m'), memoryview(b''), slice(1), range(1), object(), _Slots, BaseExceptionGroup('m', [ValueError()])]
_coro.close()
`;

const PROGRAM = (modules: readonly string[], types: boolean): string => `import sys, types, builtins, collections
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
        pending.extend(cls.__mro__[1:])
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
`;

/** Names that this grader adds on purpose, which CPython lacks. */
const GRADER_EXTENSIONS = ['M builtins Turtle'];

/** The parts of the interpreter the script uses, loaded once the class orders are set. */
const interpreter = {} as {
  parsePython: typeof ParsePython;
  runModule: typeof RunModule;
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
  if (requested.length > 0 && process.argv.includes('--write')) {
    // The table covers every module, so one written from a subset would drop the others' entries.
    throw new Error('--write compares every supported module and takes no module names');
  }
  const modules =
    requested.length > 0 ? requested : [...interpreter.supportedModules].filter((name) => name !== '__main__');
  mkdirSync('.tmp/pythonDicts', { recursive: true });
  if (process.argv.includes('--natural')) {
    // The classes' names in the order this grader creates them, for the parent run.
    process.stdout.write(runOurTypes(PROGRAM(modules, true)));
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
    classes: differing(reference, ours, 'T'),
  };
  settleExtras(python, differences);
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
 * Settles the extra names by reading them in CPython: a class's extra names its CPython class has after all, from a
 * base this grader does not model, are no longer extra, and after each extra list come those CPython serves when read
 * though its namespace lacks them, a module's through its `__getattr__` and a class's on the instances its constructor
 * makes without arguments.
 */
function settleExtras(python: string, differences: Record<'modules' | 'classes', Record<string, Difference>>): void {
  for (const [name, difference] of Object.entries(differences.modules)) {
    if (difference[1].length === 0) continue;
    // Each module alone, as importing others adds their submodules to its namespace.
    const program = `import importlib\nmodule = importlib.import_module(${JSON.stringify(name)})\nfor key in ${JSON.stringify(difference[1])}:\n    if hasattr(module, key): print('|' + key)\n`;
    setReadable(difference, probeLines(runCPython(python, program)));
  }
  const classes = Object.entries(differences.classes).filter(([, [, extra]]) => extra.length > 0);
  const extras = JSON.stringify(Object.fromEntries(classes.map(([name, [, extra]]) => [name, extra])));
  const program = `import importlib, json
for key, extra in json.loads(${JSON.stringify(extras)}).items():
    parts = key.split('.')
    cls = None
    for index in range(len(parts) - 1, 0, -1):
        try:
            cls = importlib.import_module('.'.join(parts[:index]))
            for part in parts[index:]:
                cls = getattr(cls, part)
            break
        except Exception:
            cls = None
    if cls is None:
        continue
    for name in extra:
        if hasattr(cls, name):
            print('|C ' + key + ' ' + name)
    try:
        instance = cls()
    except Exception:
        continue
    for name in extra:
        if not hasattr(cls, name) and hasattr(instance, name):
            print('|I ' + key + ' ' + name)
`;
  const found = probeLines(runCPython(python, program)).map((line) => line.split(' ') as [string, string, string]);
  const namesOf = (kind: string, name: string): string[] =>
    found.filter(([each, key]) => each === kind && key === name).map((entry) => entry[2]);
  for (const [name, difference] of classes) {
    const onClass = namesOf('C', name);
    difference[1] = difference[1].filter((key) => !onClass.includes(key));
    setReadable(difference, namesOf('I', name));
  }
}

function setReadable(difference: Difference, readable: string[]): void {
  if (readable.length > 0) difference[2] = readable;
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

type Difference = [missing: string[], extra: string[], readable?: string[]];

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

/**
 * The modules and classes whose namespaces differ from CPython's, with the names CPython's has, the extra ones, and the
 * extra ones CPython serves when read.
 */
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
  const ourTypes = probeLines(runOurTypes(typeProgram)).filter((line) => line.startsWith('T '));
  const referenceTypes = probeLines(runCPython(python, typeProgram)).filter((line) => line.startsWith('T '));
  // A class only one side reaches is a name a module lacks, which the module's lines show.
  const [ourTypeNames, referenceTypeNames] = [typeNames(ourTypes), typeNames(referenceTypes)];
  lines.reference.push(...referenceTypes.filter((line) => shared(line, ourTypeNames)));
  lines.ours.push(...ourTypes.filter((line) => shared(line, referenceTypeNames)));
  const natural = spawnSync('bun', [process.argv[1] as string, '--natural', ...modules], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  const naturalTypes = probeLines(natural.stdout).filter((line) => line.startsWith('T '));
  if (natural.status !== 0 || naturalTypes.length === 0) {
    const detail = (natural.stderr || natural.error?.message || '').trim();
    throw new Error(`The --natural run listed no types (exit status ${natural.status})${detail ? `:\n${detail}` : ''}`);
  }
  lines.natural.push(...naturalTypes);
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
  const probe = `import sys; v = '.'.join(map(str, sys.version_info[:3])); assert v == '${EXPECTED_PYTHON}', v; print(sys.executable)`;
  const viaMise = spawnSync('mise', ['exec', `python@${EXPECTED_PYTHON}`, '--', 'python', '-I', '-c', probe], {
    encoding: 'utf8',
  });
  if (viaMise.status === 0) return viaMise.stdout.trim();
  const direct = spawnSync('python3.14', ['-I', '-c', probe], { encoding: 'utf8' });
  if (direct.status === 0) return direct.stdout.trim();
  const detail = (viaMise.stderr || direct.stderr || viaMise.error?.message || direct.error?.message || '').trim();
  throw new Error(
    `CPython ${EXPECTED_PYTHON} is required (run \`mise install\` to install the version pinned in mise.toml)${detail ? `: ${detail}` : ''}`
  );
}

function runCPython(python: string, program: string): string {
  const result = spawnSync(python, ['-I', '-W', 'ignore', '-c', program], { encoding: 'utf8' });
  if (result.status !== 0) console.error(`CPython: ${result.stderr.trim().split('\n').at(-1)}`);
  return result.stdout;
}

/** Runs the type program in this grader, failing unless it completes, as a partial listing passes for a full one. */
function runOurTypes(program: string): string {
  const run = runOurs(program);
  if (run.failure) throw new Error(`The type program failed in this grader: ${run.failure}`);
  return run.output;
}

/** Runs the program in this grader, returning its output and the attributes the module leaves unsupported. */
function runOurs(program: string, module?: string): { output: string; unsupported: string[]; failure?: string } {
  const runtime = new interpreter.Runtime();
  const unsupported: string[] = [];
  try {
    const run = interpreter.runModule(runtime, interpreter.parsePython(program));
    const failure = run.uncaughtException?.split('\n').at(-1);
    if (failure) console.error(`${module ?? 'types'}: ${failure}`);
    const value = (
      runtime as unknown as { modules: Map<string, { unsupported: Map<string, string>; imports: Map<string, string> }> }
    ).modules.get(module ?? '');
    unsupported.push(...(value?.unsupported.keys() ?? []), ...(value?.imports.keys() ?? []));
    return { output: run.stdout, unsupported, failure };
  } catch (error) {
    console.error(`${module ?? 'types'}: ${String(error)}`);
    return { output: '', unsupported, failure: String(error) };
  }
}

function probeLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1));
}
