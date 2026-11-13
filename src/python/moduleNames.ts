import { isRegisteredModule } from './modules';
import { MODULE_LAYOUTS } from './modules/moduleLayouts';
import { STDLIB_MODULE_NAMES } from './stdlibModuleNames';

/** The standard library modules this grader implements, which programs may import. */
export const SUPPORTED_MODULES: ReadonlySet<string> = new Set([
  '__future__',
  '__main__',
  '_abc',
  '_bz2',
  '_codecs',
  '_compat_pickle',
  '_contextvars',
  '_csv',
  '_functools',
  '_lzma',
  '_opcode',
  '_opcode_metadata',
  '_pickle',
  '_random',
  '_sre',
  '_stat',
  '_string',
  '_symtable',
  '_thread',
  '_tokenize',
  'abc',
  'annotationlib',
  'argparse',
  'ast',
  'array',
  'asyncio',
  'asyncio.graph',
  'atexit',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'bz2',
  'calendar',
  'cmath',
  'codecs',
  'collections',
  'codeop',
  'collections.abc',
  'colorsys',
  'compression',
  'compression.bz2',
  'compression.gzip',
  'compression.lzma',
  'compression.zlib',
  'concurrent',
  'concurrent.futures',
  'concurrent.futures._base',
  'concurrent.futures.thread',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'csv',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'doctest',
  'email',
  'email._encoded_words',
  'email._header_value_parser',
  'email._parseaddr',
  'email._policybase',
  'email.base64mime',
  'email.charset',
  'email.contentmanager',
  'email.encoders',
  'email.errors',
  'email.feedparser',
  'email.generator',
  'email.header',
  'email.headerregistry',
  'email.iterators',
  'email.message',
  'email.mime',
  'email.mime.application',
  'email.mime.audio',
  'email.mime.base',
  'email.mime.image',
  'email.mime.message',
  'email.mime.multipart',
  'email.mime.nonmultipart',
  'email.mime.text',
  'email.parser',
  'email.policy',
  'email.quoprimime',
  'email.utils',
  'encodings',
  'enum',
  'errno',
  'fnmatch',
  'fractions',
  'functools',
  'gc',
  'getopt',
  'genericpath',
  'gettext',
  'glob',
  'graphlib',
  'hashlib',
  'gzip',
  'heapq',
  'hmac',
  'html',
  'html.entities',
  'html.parser',
  'http',
  'http.cookies',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'json.decoder',
  'json.encoder',
  'json.scanner',
  'keyword',
  'logging',
  'logging.config',
  'logging.handlers',
  'lzma',
  'marshal',
  'math',
  'ntpath',
  'nturl2path',
  'numbers',
  'opcode',
  'operator',
  'optparse',
  'pickle',
  'pickletools',
  'os',
  'os.path',
  'pathlib',
  'posixpath',
  'plistlib',
  'pprint',
  'pydoc',
  'pydoc_data',
  'pydoc_data.module_docs',
  'pydoc_data.topics',
  'queue',
  'quopri',
  'random',
  're',
  're._casefix',
  're._compiler',
  're._constants',
  're._parser',
  'reprlib',
  'sched',
  'sre_compile',
  'sre_constants',
  'sre_parse',
  'shlex',
  'stat',
  'statistics',
  'string',
  'string.templatelib',
  'stringprep',
  'struct',
  'symtable',
  'sys',
  'textwrap',
  'this',
  'threading',
  'time',
  'token',
  'tokenize',
  'tomllib',
  'tomllib._parser',
  'tomllib._re',
  'tarfile',
  'tomllib._types',
  'traceback',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'unittest.async_case',
  'unittest.case',
  'unittest.loader',
  'unittest.main',
  'unittest.mock',
  'unittest.result',
  'unittest.runner',
  'unittest.signals',
  'unittest.suite',
  'unittest.util',
  'urllib',
  'urllib.parse',
  'uuid',
  'wave',
  'pyexpat',
  'pyexpat.errors',
  'pyexpat.model',
  'xml',
  'xml.dom',
  'xml.dom.NodeFilter',
  'xml.dom.domreg',
  'xml.dom.expatbuilder',
  'xml.dom.minicompat',
  'xml.dom.minidom',
  'xml.dom.pulldom',
  'xml.dom.xmlbuilder',
  'xml.etree',
  'xml.etree.ElementInclude',
  'xml.etree.ElementPath',
  'xml.etree.ElementTree',
  'xml.etree.cElementTree',
  'xml.parsers',
  'xml.parsers.expat',
  'xml.parsers.expat.errors',
  'xml.parsers.expat.model',
  'xml.sax',
  'xml.sax._exceptions',
  'xml.sax.expatreader',
  'xml.sax.handler',
  'xml.sax.saxutils',
  'xml.sax.xmlreader',
  'weakref',
  'warnings',
  'zipfile',
  'zipfile._path',
  'zipfile._path.glob',
  'zlib',
]);

/** The modules of sys.stdlib_module_names that CPython's macOS build lacks, which a program may import to fail. */
const ABSENT_MODULES: ReadonlySet<string> = new Set([
  'nt',
  '_winapi',
  '_gdbm',
  '_overlapped',
  '_wmi',
  'msvcrt',
  'winreg',
  'winsound',
]);

/**
 * The modules of other platforms and the C modules that CPython's pure Python modules try to import, whose import
 * fails here as it does where CPython lacks them.
 */
export const MISSING_PLATFORM_MODULES: ReadonlySet<string> = new Set([
  ...ABSENT_MODULES,
  'fcntl',
  'posix',
  'pwd',
  'grp',
]);

export function isSupportedModule(module: string): boolean {
  return (
    SUPPORTED_MODULES.has(module) ||
    ABSENT_MODULES.has(module) ||
    (module.startsWith('encodings.') && isRegisteredModule(module))
  );
}

/** The codec modules CPython has only for Windows, which this grader does not implement. */
const WINDOWS_CODEC_MODULES: ReadonlySet<string> = new Set(['_win_cp_codecs', 'mbcs', 'oem']);

/**
 * The submodule of the `encodings` package that an import of `module` finds missing, if any, as CPython has none but
 * the codecs this grader implements and those for Windows.
 */
export function missingCodecModule(module: string): string | undefined {
  if (!module.startsWith('encodings.')) return undefined;
  const codec = module.split('.').slice(0, 2).join('.');
  if (WINDOWS_CODEC_MODULES.has(codec.slice('encodings.'.length))) return undefined;
  return isRegisteredModule(codec) ? undefined : codec;
}

/** Names an import that this grader rejects, for its error message. */
export function unsupportedModuleFeature(module: string): string {
  const top = module.split('.')[0];
  return STDLIB_MODULE_NAMES.has(top)
    ? `モジュール ${module}`
    : `標準ライブラリ以外のモジュールや別のファイルの import（${module}）`;
}

/**
 * The submodules CPython 3.14.10 has in the packages this grader implements that this grader does not implement,
 * besides the codecs of `encodings`.
 */
const UNSUPPORTED_SUBMODULES: ReadonlySet<string> = new Set([
  ...[
    '__main__',
    'base_events',
    'base_futures',
    'base_subprocess',
    'base_tasks',
    'constants',
    'coroutines',
    'events',
    'exceptions',
    'format_helpers',
    'futures',
    'locks',
    'log',
    'mixins',
    'proactor_events',
    'protocols',
    'queues',
    'runners',
    'selector_events',
    'sslproto',
    'staggered',
    'streams',
    'subprocess',
    'taskgroups',
    'tasks',
    'threads',
    'timeouts',
    'tools',
    'transports',
    'trsock',
    'unix_events',
    'windows_events',
    'windows_utils',
  ].map((name) => `asyncio.${name}`),
  'compression._common',
  'compression.zstd',
  'concurrent.futures.interpreter',
  'concurrent.futures.process',
  'concurrent.interpreters',
  'http.client',
  'http.cookiejar',
  'http.server',
  ...[
    '_abc',
    '_bootstrap',
    '_bootstrap_external',
    'abc',
    'machinery',
    'metadata',
    'readers',
    'resources',
    'simple',
    'util',
  ].map((name) => `importlib.${name}`),
  'json.__main__',
  'json.tool',
  'pathlib._local',
  'pathlib._os',
  'pathlib.types',
  'unittest.__main__',
  'unittest._log',
  'urllib.error',
  'urllib.request',
  'urllib.response',
  'urllib.robotparser',
  'zipfile.__main__',
]);

/**
 * The ModuleNotFoundError CPython raises importing `module`, which this grader does not implement, when CPython has no
 * such module either: the name it gives, and its message. A module outside the standard library counts as absent only
 * for library code, since a program's own files may provide one.
 */
export function absentModule(module: string, outsideStdlib: boolean): { name: string; message: string } | undefined {
  const parts = module.split('.');
  const top = parts[0] as string;
  if (!STDLIB_MODULE_NAMES.has(top))
    return outsideStdlib ? { name: top, message: `No module named '${top}'` } : undefined;
  if (!SUPPORTED_MODULES.has(top)) return undefined;
  for (let index = 2; index <= parts.length; index++) {
    const name = parts.slice(0, index).join('.');
    if (isSupportedModule(name) || isRegisteredModule(name)) continue;
    if (UNSUPPORTED_SUBMODULES.has(name)) return undefined;
    if (name.startsWith('encodings.') && missingCodecModule(name) === undefined) return undefined;
    const parent = parts.slice(0, index - 1).join('.');
    return {
      name,
      message:
        MODULE_LAYOUTS[parent]?.kind === 'package'
          ? `No module named '${name}'`
          : `No module named '${name}'; '${parent}' is not a package`,
    };
  }
  return undefined;
}
