# Prints, as JSON, the names CPython (3.14.10) has in each module this grader implements and in the values of
# VALUE_EXPRESSIONS, which scripts/checkPythonNames.ts looks up in this grader:
#   mise exec -- python scripts/pythonData/generateModuleNames.py > .tmp/pythonNames.json
# Run it from the repository root, since it reads the module list from src/python/moduleNames.ts.
import importlib
import json
import re
import subprocess
import sys

if sys.version_info[:3] != (3, 14, 10):
    raise SystemExit(f'Expected CPython 3.14.10, got {sys.version.split()[0]}')

# The values whose `dir()` is compared, as expressions a program of the grader evaluates after `import`ing MODULES.
VALUE_EXPRESSIONS = [
    '0', 'True', '1.5', '1j', "'s'", "b'b'", 'bytearray(b"b")', '[]', '()', '{}', 'set()', 'frozenset()', 'range(1)',
    'slice(1)', 'None', 'NotImplemented', 'Ellipsis', 'object()', 'type', 'int', 'iter([])', 'iter(())', 'iter("")',
    'iter({})', 'iter(set())', 'iter(range(1))', 'reversed([])', 'enumerate([])', 'zip()', 'map(abs, [])',
    'filter(None, [])', '{}.keys()', '{}.values()', '{}.items()', 'memoryview(b"b")', 'property()',
    'staticmethod(abs)', 'classmethod(abs)', 'super(int, 1)', 'abs', '(lambda: 0)', '(lambda: 0).__code__',
    '(x for x in [])', 'ValueError("x")', 'BaseExceptionGroup("m", [ValueError()])', 'sys', 'sys.flags',
    'sys.float_info', 'sys.int_info', 'sys.version_info', 'sys.hash_info', 'collections.deque()',
    'collections.defaultdict()', 'collections.OrderedDict()', 'collections.Counter()', 'collections.ChainMap()',
    'collections.namedtuple("P", "x y")(1, 2)', 'datetime.date(2020, 1, 1)', 'datetime.datetime(2020, 1, 1)',
    'datetime.time()', 'datetime.timedelta()', 'datetime.timezone.utc', 'decimal.Decimal(1)',
    'decimal.getcontext()', 'fractions.Fraction(1)', 'io.StringIO()', 'io.BytesIO()', 're.compile("a")',
    're.match("a", "a")', 'array.array("i")', 'threading.Lock()', 'threading.RLock()', 'threading.Event()',
    'threading.Condition()', 'threading.Semaphore()', 'threading.current_thread()', 'queue.Queue()',
    'functools.partial(abs)', 'random.Random()', 'itertools.count()', 'itertools.chain()', 'enum.Enum',
    'time.localtime(0)', 'types.SimpleNamespace()', 'string.Formatter()', 'string.Template("")',
    'operator.itemgetter(0)', 'weakref.ref(int)', 'contextvars.ContextVar("v")', 'contextvars.copy_context()',
    'ipaddress.ip_address("1.2.3.4")', 'uuid.UUID(int=0)', 'pathlib.PurePosixPath("a")',
    'statistics.NormalDist()', 'typing.TypeVar("T")', 'typing.Any', 'list[int]', 'int | str',
]

# The modules MODULES imports so that VALUE_EXPRESSIONS can name them.
VALUE_MODULES = [
    'array', 'collections', 'contextvars', 'datetime', 'decimal', 'enum', 'fractions', 'functools', 'io', 'ipaddress',
    'itertools', 'operator', 'pathlib', 'queue', 'random', 're', 'statistics', 'string', 'sys', 'threading', 'time',
    'types', 'typing', 'uuid', 'weakref',
]


def main():
    with open('src/python/moduleNames.ts', encoding='utf-8') as file:
        source = file.read()
    listed = re.search(r'SUPPORTED_MODULES[^\[]*\[(.*?)\]\);', source, re.S).group(1)
    modules = [name for name in re.findall(r"'([^']+)'", listed) if name != '__main__']
    namespace = {name: importlib.import_module(name) for name in VALUE_MODULES}
    values = {expression: value_names(eval(expression, namespace)) for expression in VALUE_EXPRESSIONS}
    json.dump({'modules': {name: module_names(name) for name in modules}, 'values': values}, sys.stdout, indent=0,
              sort_keys=True)
    print()


def value_names(value):
    """The names of the value's `dir()`, marked with a leading '!' when reading them raises AttributeError."""
    names = []
    for name in sorted(dir(value)):
        try:
            getattr(value, name)
        except AttributeError:
            name = '!' + name
        names.append(name)
    return names


def module_names(name):
    """
    Maps each name of the module to the name of the module it holds, or to '' when it holds no module, in a process
    that imports only that module, as the submodules other imports load would otherwise appear in it.
    """
    result = subprocess.run([sys.executable, '-I', '-c', LIST_NAMES, name], capture_output=True, text=True, check=True)
    # A module such as `this` prints when imported, before the names.
    return json.loads(result.stdout.splitlines()[-1])


LIST_NAMES = """
import importlib, json, sys, types
module = importlib.import_module(sys.argv[1])
def describe(value):
    return 'module:' + value.__name__ if isinstance(value, types.ModuleType) else ''
print(json.dumps({key: describe(getattr(module, key)) for key in dir(module)}))
"""


main()
