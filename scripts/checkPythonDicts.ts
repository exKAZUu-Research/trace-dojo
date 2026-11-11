// Compares the class `__dict__`s and the module namespaces of this grader with CPython's (3.14.10), and prints the
// lines that differ (`<` CPython, `>` this grader) and their count:
//   bun scripts/checkPythonDicts.ts [module ...]
// For each builtin type, internal type (iterators, views, descriptors, code, frame, ...) and public class of the
// supported modules, the program it runs prints the type and the sorted keys of `vars(T)`; for each module, the keys of
// `vars(module)` in order, with the `__module__` of each function and class. Each module is imported in a process of its
// own, as other imports would add their submodules to its namespace. The module attributes this grader leaves
// unsupported, such as `__file__`, are left out of both sides.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LIMITS } from '../src/interpreter/limits';
import { parsePython } from '../src/python/parse';
import { runModule } from '../src/python/run';
import { Runtime } from '../src/python/runtime';

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
    lines = []
    for cls in found:
        # The importer of CPython's builtins module is what this grader leaves unsupported.
        if cls.__module__ in ('__main__', '_frozen_importlib'):
            continue
        for key in cls.__dict__:
            lines.append('T ' + type_name(cls) + ' ' + key)
    for line in sorted(set(lines)):
        emit(line)
`;

if (import.meta.main) {
  const requested = process.argv.slice(2);
  // The type program prints far more than a learner's program may.
  Object.assign(LIMITS, { maxOperations: 1e9, maxMilliseconds: 1e6, maxSlots: 1e9, maxOutputLength: 1e9 });
  // Imported after the interpreter, as moduleNames.ts would otherwise start an import cycle in the wrong place.
  const { SUPPORTED_MODULES } = await import('../src/python/moduleNames');
  const modules = requested.length > 0 ? requested : [...SUPPORTED_MODULES].filter((name) => name !== '__main__');
  mkdirSync('.tmp/pythonDicts', { recursive: true });
  const python = pythonExecutable();
  const reference: string[] = [];
  const ours: string[] = [];
  const allowed = new Set<string>();
  for (const [index, module] of modules.entries()) {
    const program = PROGRAM([module], false);
    reference.push(...probeLines(runCPython(python, program)));
    const run = runOurs(program, module);
    ours.push(...probeLines(run.output));
    for (const key of run.unsupported) allowed.add(`M ${module} ${key}`);
    if ((index + 1) % 50 === 0) console.error(`${index + 1}/${modules.length}`);
  }
  const typeProgram = PROGRAM(modules, true);
  writeFileSync('.tmp/pythonDicts/types.py', typeProgram);
  const ourTypes = probeLines(runOurs(typeProgram).output).filter((line) => line.startsWith('T '));
  // A class this grader lacks is a name its module lacks, which the module's lines show.
  const ourTypeNames = new Set(ourTypes.map((line) => line.split(' ')[1]));
  reference.push(
    ...probeLines(runCPython(python, typeProgram)).filter(
      (line) => line.startsWith('T ') && ourTypeNames.has(line.split(' ')[1] as string)
    )
  );
  ours.push(...ourTypes);
  const keep = (line: string): boolean => !allowed.has(line.split(' ').slice(0, 3).join(' '));
  writeFileSync('.tmp/pythonDicts/cpython.txt', `${reference.filter(keep).join('\n')}\n`);
  writeFileSync('.tmp/pythonDicts/ours.txt', `${ours.filter(keep).join('\n')}\n`);
  const diff = spawnSync('diff', ['.tmp/pythonDicts/cpython.txt', '.tmp/pythonDicts/ours.txt'], { encoding: 'utf8' });
  const changed = diff.stdout.split('\n').filter((line) => /^[<>] /.test(line));
  for (const line of changed) console.log(line);
  console.log(`differing lines: ${changed.length}`);
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
  const runtime = new Runtime();
  const unsupported: string[] = [];
  try {
    const run = runModule(runtime, parsePython(program));
    if (run.uncaughtException) console.error(`${module ?? 'types'}: ${run.uncaughtException.split('\n').at(-1)}`);
    const value = runtime.modules.get(module ?? '');
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
