// A snapshot taken from CPython 3.14.10 by importing each module into a fresh interpreter and reading `sys.modules`
// and the classes it defines; no script in this repository regenerates it, so edit it by hand against CPython.

/** The modules CPython has imported when a program starts. */
export const STARTUP_MODULES: ReadonlySet<string> = new Set(
  '__main__ _abc _codecs _collections_abc _frozen_importlib _frozen_importlib_external _imp _io _signal _sitebuiltins _stat _thread _warnings _weakref abc builtins codecs encodings encodings.aliases encodings.utf_8 errno genericpath marshal os os.path posix posixpath site stat sys time zipimport'.split(
    ' '
  )
);

/**
 * The classes that CPython's startup gives subclasses of other modules, or ones only its interpreter has, which a
 * program cannot tell from its own imports.
 */
export const STARTUP_SUBCLASSED: ReadonlySet<string> = new Set(
  '_frozen_importlib_external._LoaderBasics abc.ABC abc.ABCMeta builtins.Exception builtins.ImportError builtins.LookupError builtins.OSError builtins.RuntimeError builtins.SystemError builtins.TypeError builtins.ValueError builtins.builtin_function_or_method builtins.classmethod builtins.dict builtins.list builtins.object builtins.property builtins.staticmethod builtins.tuple builtins.type codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter collections.abc.MutableMapping types.GenericAlias'.split(
    ' '
  )
);

/** The modules this grader implements that importing each one imports in CPython. */
const IMPORTS: Record<string, string> = {
  _ast_unparse:
    '_ast _functools ast collections collections.abc contextlib enum functools itertools keyword operator reprlib types',
  _colorize:
    '_ast _functools _sre _tokenize annotationlib ast collections collections.abc copy copyreg dataclasses enum functools importlib inspect io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib token tokenize types weakref',
  _markupbase:
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  annotationlib: '_ast ast enum keyword types',
  argparse:
    '_functools _sre collections collections.abc copyreg enum functools gettext itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  array: 'collections collections.abc itertools keyword operator reprlib',
  ast: '_ast',
  asyncio:
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib ast asyncio.graph atexit base64 binascii codeop collections collections.abc concurrent concurrent.futures contextlib contextvars copy copyreg dataclasses enum functools heapq importlib inspect io itertools keyword logging math operator re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types warnings weakref',
  'asyncio.graph':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib ast asyncio atexit base64 binascii codeop collections collections.abc concurrent concurrent.futures contextlib contextvars copy copyreg dataclasses enum functools heapq importlib inspect io itertools keyword logging math operator re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types warnings weakref',
  base64: 'binascii struct',
  bz2: '_bz2 compression compression._common compression._common._streams io',
  calendar: '_functools collections collections.abc datetime enum functools itertools keyword operator reprlib types',
  codeop: '__future__ warnings',
  collections: 'collections.abc itertools keyword operator reprlib',
  'collections.abc': 'collections itertools keyword operator reprlib',
  'compression._common': 'compression',
  'compression._common._streams': 'compression compression._common io',
  'compression.bz2': '_bz2 bz2 compression compression._common compression._common._streams io',
  'compression.gzip':
    'compression compression._common compression._common._streams gzip io itertools struct types weakref zlib',
  'compression.lzma': '_lzma compression compression._common compression._common._streams io lzma',
  'compression.zlib': 'compression zlib',
  'concurrent.futures':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib ast atexit codeop collections collections.abc concurrent contextlib copy copyreg dataclasses enum functools importlib inspect io itertools keyword logging operator re re._casefix re._compiler re._constants re._parser reprlib string textwrap threading token tokenize traceback types warnings weakref',
  configparser:
    '_functools _sre collections collections.abc contextlib copyreg enum functools io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  contextlib: '_functools collections collections.abc functools itertools keyword operator reprlib types',
  copy: 'copyreg itertools types weakref',
  csv: '_csv io types',
  dataclasses:
    '_ast _functools _sre _tokenize annotationlib ast collections collections.abc copy copyreg enum functools importlib inspect io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib token tokenize types weakref',
  decimal: 'collections collections.abc itertools keyword numbers operator reprlib',
  difflib: 'collections collections.abc heapq itertools keyword operator reprlib types',
  doctest:
    '__future__ _ast _bz2 _colorize _functools _lzma _random _sre _tokenize annotationlib argparse ast asyncio asyncio.graph atexit base64 binascii bisect bz2 codeop collections collections.abc compression compression._common compression._common._streams concurrent concurrent.futures contextlib contextvars copy copyreg dataclasses difflib enum fnmatch functools gettext glob heapq importlib inspect io itertools json json.decoder json.encoder json.scanner keyword logging lzma math operator pprint random re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types typing unicodedata unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref zlib',
  'email._encoded_words':
    '_functools _sre base64 binascii collections collections.abc copyreg email email.errors enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib string struct types',
  'email._header_value_parser':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._parseaddr email.errors email.utils enum functools ipaddress itertools keyword math operator re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email._parseaddr': 'email',
  'email._policybase':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._parseaddr email.base64mime email.charset email.encoders email.errors email.header email.quoprimime email.utils enum functools ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.base64mime': 'base64 binascii email struct',
  'email.charset':
    '_functools _sre base64 binascii collections collections.abc copyreg email email.base64mime email.encoders email.errors email.quoprimime enum functools itertools keyword operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types',
  'email.contentmanager':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._parseaddr email._policybase email.base64mime email.charset email.encoders email.errors email.header email.iterators email.message email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.encoders': 'base64 binascii email quopri struct',
  'email.errors': 'email',
  'email.feedparser':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._parseaddr email._policybase email.base64mime email.charset email.encoders email.errors email.header email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.generator':
    '_functools _random _sre bisect collections collections.abc copy copyreg datetime email email._parseaddr email.errors email.utils enum functools io ipaddress itertools keyword math operator random re re._casefix re._compiler re._constants re._parser reprlib types urllib urllib.parse warnings weakref',
  'email.header':
    '_functools _sre base64 binascii collections collections.abc copyreg email email.base64mime email.charset email.encoders email.errors email.quoprimime enum functools itertools keyword operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types',
  'email.headerregistry':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email.errors email.utils enum functools ipaddress itertools keyword math operator re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.iterators': 'email io',
  'email.message':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._parseaddr email._policybase email.base64mime email.charset email.encoders email.errors email.header email.iterators email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime': 'email',
  'email.mime.application':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.mime.nonmultipart email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.audio':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.mime.nonmultipart email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.base':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.image':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.mime.nonmultipart email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.message':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.mime.nonmultipart email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.multipart':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.nonmultipart':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.mime.text':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.mime email.mime.base email.mime.nonmultipart email.policy email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.parser':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._parseaddr email._policybase email.base64mime email.charset email.encoders email.errors email.feedparser email.header email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.policy':
    '_functools _sre base64 binascii collections collections.abc copyreg datetime email email._encoded_words email._header_value_parser email._parseaddr email._policybase email.base64mime email.charset email.contentmanager email.encoders email.errors email.header email.headerregistry email.iterators email.message email.quoprimime email.utils enum functools io ipaddress itertools keyword math operator quopri re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings',
  'email.quoprimime':
    '_functools _sre collections collections.abc copyreg email enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib string types',
  'email.utils':
    '_functools _sre collections collections.abc copyreg datetime email email._parseaddr enum functools ipaddress itertools keyword math operator re re._casefix re._compiler re._constants re._parser reprlib types urllib urllib.parse warnings',
  'encodings.base64_codec': 'base64 binascii struct',
  'encodings.bz2_codec': '_bz2 bz2 compression compression._common compression._common._streams io',
  'encodings.hex_codec': 'binascii',
  'encodings.zlib_codec': 'zlib',
  enum: 'types',
  fnmatch:
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  fractions:
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword math numbers operator re re._casefix re._compiler re._constants re._parser reprlib types',
  functools: '_functools collections collections.abc itertools keyword operator reprlib types',
  getopt: 'gettext operator',
  gettext: 'operator',
  glob: '_functools _sre collections collections.abc contextlib copyreg enum fnmatch functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  graphlib: 'types',
  gzip: 'compression compression._common compression._common._streams io itertools struct types weakref zlib',
  html: '_functools _sre collections collections.abc copyreg enum functools html.entities itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  'html.entities':
    '_functools _sre collections collections.abc copyreg enum functools html itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  'html.parser':
    '_functools _markupbase _sre collections collections.abc copyreg enum functools html html.entities itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  http: 'enum types',
  'http.cookies':
    '_functools _sre collections collections.abc copyreg enum functools http itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib string types',
  inspect:
    '_ast _functools _sre _tokenize annotationlib ast collections collections.abc copyreg enum functools importlib io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib token tokenize types weakref',
  ipaddress: '_functools collections collections.abc functools itertools keyword operator reprlib types',
  json: '_functools _sre collections collections.abc copyreg enum functools itertools json.decoder json.encoder json.scanner keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  'json.decoder':
    '_functools _sre collections collections.abc copyreg enum functools itertools json json.encoder json.scanner keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  'json.encoder':
    '_functools _sre collections collections.abc copyreg enum functools itertools json json.decoder json.scanner keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  'json.scanner':
    '_functools _sre collections collections.abc copyreg enum functools itertools json json.decoder json.encoder keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  logging:
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib ast atexit codeop collections collections.abc contextlib copy copyreg dataclasses enum functools importlib inspect io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib string textwrap threading token tokenize traceback types warnings weakref',
  'logging.config':
    '__future__ _ast _colorize _compat_pickle _functools _sre _tokenize annotationlib ast atexit codeop collections collections.abc contextlib copy copyreg dataclasses enum functools heapq importlib inspect io itertools keyword logging logging.handlers math operator pickle queue re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types warnings weakref',
  'logging.handlers':
    '__future__ _ast _colorize _compat_pickle _functools _sre _tokenize annotationlib ast atexit codeop collections collections.abc contextlib copy copyreg dataclasses enum functools heapq importlib inspect io itertools keyword logging operator pickle queue re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types warnings weakref',
  lzma: '_lzma compression compression._common compression._common._streams io',
  optparse: '_functools collections collections.abc functools gettext itertools keyword operator reprlib types',
  pathlib:
    '_functools _sre collections collections.abc contextlib copyreg enum fnmatch functools glob io itertools keyword ntpath operator pathlib._os re re._casefix re._compiler re._constants re._parser reprlib types',
  'pathlib._os':
    '_functools _sre collections collections.abc contextlib copyreg enum fnmatch functools glob io itertools keyword ntpath operator pathlib re re._casefix re._compiler re._constants re._parser reprlib types',
  pickle:
    '_compat_pickle _functools collections collections.abc copyreg functools io itertools keyword operator reprlib struct types',
  pickletools:
    '_compat_pickle _functools _sre collections collections.abc copyreg enum functools io itertools keyword operator pickle re re._casefix re._compiler re._constants re._parser reprlib struct types',
  plistlib:
    '_functools _sre binascii collections collections.abc copyreg datetime enum functools io itertools keyword operator pyexpat pyexpat.errors pyexpat.model re re._casefix re._compiler re._constants re._parser reprlib struct types xml xml.parsers xml.parsers.expat',
  pprint: 'collections collections.abc io itertools keyword operator reprlib types',
  pydoc:
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib ast codeop collections collections.abc contextlib copy copyreg dataclasses enum functools importlib inspect io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib textwrap threading token tokenize traceback types warnings weakref',
  pyexpat: 'pyexpat.errors pyexpat.model',
  'pyexpat.errors': 'pyexpat pyexpat.model',
  'pyexpat.model': 'pyexpat pyexpat.errors',
  queue: 'collections collections.abc heapq itertools keyword operator reprlib threading types',
  quopri: 'binascii',
  random: '_random bisect itertools math operator',
  re: '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re._casefix re._compiler re._constants re._parser reprlib types',
  're._casefix':
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._compiler re._constants re._parser reprlib types',
  're._compiler':
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._constants re._parser reprlib types',
  're._constants':
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._compiler re._parser reprlib types',
  're._parser':
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._compiler re._constants reprlib types',
  reprlib: 'itertools',
  sched: 'collections collections.abc heapq itertools keyword operator reprlib threading types',
  shlex: 'io',
  statistics:
    '_functools _random _sre bisect collections collections.abc copyreg decimal enum fractions functools itertools keyword math numbers operator random re re._casefix re._compiler re._constants re._parser reprlib types',
  'string.templatelib': 'string',
  stringprep: 'unicodedata',
  symtable: '_symtable enum itertools types weakref',
  tarfile:
    '_bz2 _functools _lzma _sre bz2 collections collections.abc compression compression._common compression._common._streams copy copyreg enum fnmatch functools io itertools keyword lzma operator re re._casefix re._compiler re._constants re._parser reprlib struct types weakref zlib',
  textwrap:
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types',
  threading: 'itertools types',
  tokenize:
    '_functools _sre _tokenize collections collections.abc copyreg enum functools io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib token types',
  tomllib:
    '__future__ _functools _sre collections collections.abc copyreg datetime enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib tomllib._parser tomllib._re types',
  'tomllib._parser':
    '__future__ _functools _sre collections collections.abc copyreg datetime enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib tomllib tomllib._re types',
  'tomllib._re':
    '__future__ _functools _sre collections collections.abc copyreg datetime enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib tomllib tomllib._parser types',
  'tomllib._types':
    '__future__ _functools _sre collections collections.abc copyreg datetime enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib tomllib tomllib._parser tomllib._re types typing',
  traceback:
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib ast codeop collections collections.abc contextlib copy copyreg dataclasses enum functools importlib inspect io itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize types warnings weakref',
  typing: '_functools collections collections.abc copyreg functools itertools keyword operator reprlib types',
  unittest:
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest._log':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast atexit codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword logging operator pprint re re._casefix re._compiler re._constants re._parser reprlib string textwrap threading token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.async_case':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast asyncio asyncio.graph atexit base64 binascii codeop collections collections.abc concurrent concurrent.futures contextlib contextvars copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword logging math operator pprint re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.case':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.loader':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.main':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.loader unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.mock':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast asyncio asyncio.graph atexit base64 binascii codeop collections collections.abc concurrent concurrent.futures contextlib contextvars copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword logging math operator pprint re re._casefix re._compiler re._constants re._parser reprlib string struct textwrap threading token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.result':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.runner unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.runner':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.signals unittest.suite unittest.util warnings weakref',
  'unittest.signals':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.suite unittest.util warnings weakref',
  'unittest.suite':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.util warnings weakref',
  'unittest.util':
    '__future__ _ast _colorize _functools _sre _tokenize annotationlib argparse ast codeop collections collections.abc contextlib copy copyreg dataclasses difflib enum fnmatch functools gettext heapq importlib inspect io itertools keyword operator pprint re re._casefix re._compiler re._constants re._parser reprlib textwrap token tokenize traceback types unittest unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite warnings weakref',
  'urllib.parse':
    '_functools _sre collections collections.abc copyreg enum functools ipaddress itertools keyword math operator re re._casefix re._compiler re._constants re._parser reprlib types urllib warnings',
  uuid: 'enum types',
  wave: 'collections collections.abc itertools keyword operator reprlib struct',
  weakref: 'itertools types',
  'xml.dom': 'xml xml.dom.domreg',
  'xml.dom.NodeFilter': 'xml xml.dom xml.dom.domreg',
  'xml.dom.domreg': 'xml xml.dom',
  'xml.dom.expatbuilder':
    'copy copyreg io itertools pyexpat pyexpat.errors pyexpat.model types weakref xml xml.dom xml.dom.NodeFilter xml.dom.domreg xml.dom.minicompat xml.dom.minidom xml.dom.xmlbuilder xml.parsers xml.parsers.expat',
  'xml.dom.minicompat': 'xml xml.dom xml.dom.domreg',
  'xml.dom.minidom':
    'copy copyreg io itertools types weakref xml xml.dom xml.dom.NodeFilter xml.dom.domreg xml.dom.minicompat xml.dom.xmlbuilder',
  'xml.dom.pulldom': 'xml xml.dom xml.dom.domreg xml.sax xml.sax._exceptions xml.sax.handler xml.sax.xmlreader',
  'xml.dom.xmlbuilder': 'copy copyreg itertools types weakref xml xml.dom xml.dom.NodeFilter xml.dom.domreg',
  'xml.etree': 'xml',
  'xml.etree.ElementInclude':
    '_functools _sre collections collections.abc contextlib copy copyreg enum functools io ipaddress itertools keyword math operator pyexpat pyexpat.errors pyexpat.model re re._casefix re._compiler re._constants re._parser reprlib types urllib urllib.parse warnings weakref xml xml.etree xml.etree.ElementPath xml.etree.ElementTree',
  'xml.etree.ElementPath':
    '_functools _sre collections collections.abc copyreg enum functools itertools keyword operator re re._casefix re._compiler re._constants re._parser reprlib types xml xml.etree',
  'xml.etree.ElementTree':
    '_functools _sre collections collections.abc contextlib copy copyreg enum functools io itertools keyword operator pyexpat pyexpat.errors pyexpat.model re re._casefix re._compiler re._constants re._parser reprlib types warnings weakref xml xml.etree xml.etree.ElementPath',
  'xml.etree.cElementTree':
    '_functools _sre collections collections.abc contextlib copy copyreg enum functools io itertools keyword operator pyexpat pyexpat.errors pyexpat.model re re._casefix re._compiler re._constants re._parser reprlib types warnings weakref xml xml.etree xml.etree.ElementPath xml.etree.ElementTree',
  'xml.parsers': 'xml',
  'xml.parsers.expat': 'pyexpat pyexpat.errors pyexpat.model xml xml.parsers',
  'xml.sax': 'xml xml.sax._exceptions xml.sax.handler xml.sax.xmlreader',
  'xml.sax._exceptions': 'xml xml.sax xml.sax.handler xml.sax.xmlreader',
  'xml.sax.expatreader':
    '_bz2 _functools _lzma _random _sre base64 binascii bisect bz2 collections collections.abc compression compression._common compression._common._streams contextlib copyreg datetime email email._encoded_words email._parseaddr email._policybase email.base64mime email.charset email.encoders email.errors email.feedparser email.header email.iterators email.message email.parser email.quoprimime email.utils enum fnmatch functools hashlib http io ipaddress itertools keyword lzma math operator pyexpat pyexpat.errors pyexpat.model quopri random re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings weakref xml xml.parsers xml.parsers.expat xml.sax xml.sax._exceptions xml.sax.handler xml.sax.saxutils xml.sax.xmlreader zlib',
  'xml.sax.handler': 'xml xml.sax xml.sax._exceptions xml.sax.xmlreader',
  'xml.sax.saxutils':
    '_bz2 _functools _lzma _random _sre base64 binascii bisect bz2 collections collections.abc compression compression._common compression._common._streams contextlib copyreg datetime email email._encoded_words email._parseaddr email._policybase email.base64mime email.charset email.encoders email.errors email.feedparser email.header email.iterators email.message email.parser email.quoprimime email.utils enum fnmatch functools hashlib http io ipaddress itertools keyword lzma math operator quopri random re re._casefix re._compiler re._constants re._parser reprlib string struct types urllib urllib.parse warnings weakref xml xml.sax xml.sax._exceptions xml.sax.handler xml.sax.xmlreader zlib',
  'xml.sax.xmlreader': 'xml xml.sax xml.sax._exceptions xml.sax.handler',
  zipfile:
    '_bz2 _functools _lzma _sre binascii bz2 collections collections.abc compression compression._common compression._common._streams contextlib copyreg enum fnmatch functools glob importlib io itertools keyword lzma ntpath operator pathlib pathlib._os re re._casefix re._compiler re._constants re._parser reprlib struct threading types zipfile._path zipfile._path.glob zlib',
  'zipfile._path':
    '_bz2 _functools _lzma _sre binascii bz2 collections collections.abc compression compression._common compression._common._streams contextlib copyreg enum fnmatch functools glob importlib io itertools keyword lzma ntpath operator pathlib pathlib._os re re._casefix re._compiler re._constants re._parser reprlib struct threading types zipfile zipfile._path.glob zlib',
  'zipfile._path.glob':
    '_bz2 _functools _lzma _sre binascii bz2 collections collections.abc compression compression._common compression._common._streams contextlib copyreg enum fnmatch functools glob importlib io itertools keyword lzma ntpath operator pathlib pathlib._os re re._casefix re._compiler re._constants re._parser reprlib struct threading types zipfile zipfile._path zlib',
};

/** The modules importing `name` imports in CPython, among those this grader implements. */
export function cpythonImports(name: string): string[] {
  return IMPORTS[name]?.split(' ') ?? [];
}

/** The classes of other modules that the classes each module defines in CPython derive from. */
const DERIVES: Record<string, string> = {
  __future__: 'builtins.object',
  _ast_unparse: 'ast.NodeVisitor enum.IntEnum',
  _bz2: 'builtins.object',
  _colorize: 'builtins.object collections.abc.Mapping',
  _csv: 'builtins.Exception builtins.object',
  _lzma: 'builtins.Exception builtins.object',
  _markupbase: 'builtins.object',
  _random: 'builtins.object',
  _sre: 'builtins.object',
  _thread: 'builtins.object builtins.tuple',
  _tokenize: 'builtins.object',
  abc: 'builtins.classmethod builtins.object builtins.property builtins.staticmethod builtins.type collections.abc.MutableMapping decimal.SignalDictMixin',
  annotationlib: 'ast.NodeTransformer builtins.dict builtins.object enum.IntEnum',
  argparse: 'builtins.Exception builtins.object',
  array: 'builtins.object',
  ast: 'builtins.object',
  'asyncio.graph': 'builtins.object',
  binascii: 'builtins.Exception builtins.ValueError',
  bz2: 'compression._common._streams.BaseStream',
  calendar: 'builtins.IndexError builtins.ValueError builtins.object enum.IntEnum',
  codecs: 'builtins.object builtins.tuple',
  codeop: 'builtins.object',
  collections:
    'builtins.dict builtins.object collections.abc.ItemsView collections.abc.KeysView collections.abc.MutableMapping collections.abc.MutableSequence collections.abc.Sequence collections.abc.ValuesView',
  'collections.abc': 'abc.ABCMeta builtins.object types.GenericAlias',
  'compression._common._streams': 'io.BufferedIOBase io.RawIOBase',
  configparser: 'builtins.Exception builtins.object builtins.str collections.abc.MutableMapping',
  contextlib: 'abc.ABC builtins.object',
  copy: 'builtins.Exception',
  csv: 'builtins.object',
  dataclasses: 'builtins.AttributeError builtins.object',
  datetime: 'builtins.tuple',
  decimal: 'builtins.ArithmeticError builtins.TypeError builtins.ZeroDivisionError builtins.object builtins.tuple',
  difflib: 'builtins.object builtins.tuple',
  doctest:
    '_io.StringIO builtins.Exception builtins.object builtins.tuple pdb.Pdb unittest.case.TestCase unittest.suite.TestSuite',
  'email._encoded_words': 'builtins.dict',
  'email._header_value_parser': 'builtins.list builtins.str email.errors.HeaderParseError',
  'email._parseaddr': 'builtins.object',
  'email._policybase': 'builtins.object',
  'email.charset': 'builtins.object',
  'email.contentmanager': 'builtins.object',
  'email.errors': 'builtins.Exception builtins.TypeError builtins.ValueError',
  'email.feedparser': 'builtins.object',
  'email.generator': 'builtins.object',
  'email.header': 'builtins.list builtins.object',
  'email.headerregistry': 'builtins.object builtins.str',
  'email.message': 'builtins.object',
  'email.mime.application': 'email.mime.nonmultipart.MIMENonMultipart',
  'email.mime.audio': 'email.mime.nonmultipart.MIMENonMultipart',
  'email.mime.base': 'email.message.Message',
  'email.mime.image': 'email.mime.nonmultipart.MIMENonMultipart',
  'email.mime.message': 'email.mime.nonmultipart.MIMENonMultipart',
  'email.mime.multipart': 'email.mime.base.MIMEBase',
  'email.mime.nonmultipart': 'email.mime.base.MIMEBase',
  'email.mime.text': 'email.mime.nonmultipart.MIMENonMultipart',
  'email.parser': 'builtins.object',
  'email.policy': 'email._policybase.Policy',
  encodings: 'builtins.LookupError builtins.SystemError',
  'encodings.ascii':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.base64_codec':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.bz2_codec':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.hex_codec':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.latin_1':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.rot_13':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_16':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_16_be':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_16_le':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_32':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_32_be':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_32_le':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_8':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.utf_8_sig':
    'codecs.BufferedIncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  'encodings.zlib_codec':
    'codecs.Codec codecs.IncrementalDecoder codecs.IncrementalEncoder codecs.StreamReader codecs.StreamWriter',
  enum: 'builtins.dict builtins.int builtins.object builtins.str builtins.type types.DynamicClassAttribute',
  fractions: 'numbers.Rational',
  functools: 'builtins.object builtins.tuple',
  genericpath: 'builtins.object',
  getopt: 'builtins.Exception',
  gettext: 'builtins.object',
  glob: 'builtins.object',
  graphlib: 'builtins.ValueError builtins.object',
  gzip: 'builtins.OSError builtins.object compression._common._streams.BaseStream compression._common._streams.DecompressReader io.RawIOBase',
  hmac: 'builtins.object',
  'html.parser': '_markupbase.ParserBase',
  http: 'enum.IntEnum enum.StrEnum',
  'http.cookies': 'builtins.Exception builtins.dict',
  inspect: 'builtins.Exception builtins.object builtins.tuple enum.IntEnum enum.IntFlag',
  io: '_io._BufferedIOBase _io._IOBase _io._RawIOBase _io._TextIOBase builtins.OSError builtins.ValueError builtins.object',
  ipaddress: 'builtins.ValueError builtins.object',
  itertools: 'builtins.object',
  'json.decoder': 'builtins.ValueError builtins.object',
  'json.encoder': 'builtins.object',
  logging: 'builtins.object',
  'logging.config': 'builtins.dict builtins.list builtins.object builtins.tuple',
  'logging.handlers': 'builtins.object logging.FileHandler logging.Handler',
  lzma: 'compression._common._streams.BaseStream',
  numbers: 'builtins.object',
  operator: 'builtins.object',
  optparse: 'builtins.Exception builtins.object',
  os: 'abc.ABC builtins.object builtins.tuple collections.abc.MutableMapping',
  pathlib: 'builtins.NotImplementedError builtins.object collections.abc.Sequence',
  'pathlib._os': 'builtins.object',
  pickle: 'builtins.Exception builtins.object',
  pickletools: 'builtins.object',
  plistlib: 'builtins.ValueError builtins.object enum.Enum',
  pprint: 'builtins.object',
  pydoc: 'builtins.Exception builtins.object reprlib.Repr',
  pyexpat: 'builtins.object',
  queue: 'builtins.Exception builtins.object',
  random: '_random.Random',
  re: 'builtins.Exception builtins.int builtins.object enum.IntFlag',
  're._constants': 'builtins.int',
  're._parser': 'builtins.object',
  reprlib: 'builtins.object',
  sched: 'builtins.object builtins.tuple',
  shlex: 'builtins.object',
  statistics: 'builtins.ValueError builtins.object builtins.tuple',
  string: 'builtins.object',
  struct: 'builtins.Exception',
  symtable: 'builtins.object enum.StrEnum',
  tarfile: '_io.BufferedReader builtins.Exception builtins.object',
  textwrap: 'builtins.object',
  threading: 'builtins.RuntimeError builtins.object',
  time: 'builtins.tuple',
  tokenize: 'builtins.Exception builtins.object builtins.tuple',
  tomllib: 'builtins.ValueError',
  'tomllib._parser': 'builtins.object',
  traceback: 'builtins.list builtins.object builtins.tuple',
  types: 'builtins.object',
  typing: 'abc.ABCMeta builtins.object builtins.type',
  unicodedata: 'builtins.object',
  'unittest._log': 'builtins.tuple logging.Handler unittest.case._BaseTestCaseContext',
  'unittest.async_case': 'unittest.case.TestCase',
  'unittest.case': 'builtins.Exception builtins.object collections.ChainMap',
  'unittest.loader': 'builtins.object unittest.case.TestCase',
  'unittest.main': 'builtins.object',
  'unittest.mock': 'builtins.Exception builtins.list builtins.object builtins.tuple',
  'unittest.result': 'builtins.object',
  'unittest.runner': 'builtins.object unittest.result.TestResult',
  'unittest.signals': 'builtins.object',
  'unittest.suite': 'builtins.object',
  'unittest.util': 'builtins.tuple',
  'urllib.parse': 'builtins.dict builtins.object builtins.tuple',
  uuid: 'builtins.object enum.Enum',
  warnings: 'builtins.object',
  wave: 'builtins.Exception builtins.object builtins.tuple',
  weakref: 'builtins.object collections.abc.MutableMapping',
  'xml.dom': 'builtins.Exception builtins.object',
  'xml.dom.NodeFilter': 'builtins.object',
  'xml.dom.expatbuilder': 'builtins.Exception builtins.object',
  'xml.dom.minicompat': 'builtins.list builtins.tuple',
  'xml.dom.minidom':
    'builtins.object xml.dom.Node xml.dom.xmlbuilder.DOMImplementationLS xml.dom.xmlbuilder.DocumentLS',
  'xml.dom.pulldom': 'builtins.object xml.sax.handler.ContentHandler',
  'xml.dom.xmlbuilder': 'builtins.object',
  'xml.etree.ElementInclude': 'builtins.SyntaxError',
  'xml.etree.ElementPath': 'builtins.object',
  'xml.etree.ElementTree': 'builtins.SyntaxError builtins.object io.BufferedIOBase',
  'xml.parsers.expat': 'builtins.Exception',
  'xml.sax._exceptions': 'builtins.Exception',
  'xml.sax.expatreader': 'builtins.object xml.sax.xmlreader.IncrementalParser xml.sax.xmlreader.Locator',
  'xml.sax.handler': 'builtins.object',
  'xml.sax.saxutils': 'xml.sax.handler.ContentHandler xml.sax.xmlreader.XMLReader',
  'xml.sax.xmlreader': 'builtins.object',
  zipfile: 'builtins.Exception builtins.bytes builtins.object io.BufferedIOBase',
  'zipfile._path': 'builtins.object zipfile.ZipFile',
  'zipfile._path.glob': 'builtins.object',
  zlib: 'builtins.Exception builtins.object',
};

/** Whether the code of a module defines classes deriving from the class of this `module.qualname` in CPython. */
export function derivesFrom(module: string, key: string): boolean {
  return DERIVES[module]?.split(' ').includes(key) ?? false;
}
