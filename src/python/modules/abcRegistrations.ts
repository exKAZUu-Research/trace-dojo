// What CPython 3.14.10's imports add to abc's cache token, which every registration of a virtual subclass increments,
// measured by importing each module into a fresh CPython: its startup leaves the token at 17, and the code of a few
// modules registers classes when they are imported.

/** The token once CPython's startup has imported `_collections_abc`, whose code registers the builtin types. */
export const STARTUP_TOKEN = 17;

/**
 * The registrations the code of each module makes when imported. Those of `numbers` and `_decimal` (which this grader
 * names `decimal`) are the ones those modules make here.
 */
export const OWN_REGISTRATIONS: Record<string, number> = {
  io: 8,
  contextvars: 1,
  weakref: 1,
  collections: 1,
  array: 1,
};

/** The modules whose code registers classes that importing each module imports in CPython, which import others too. */
const GROUPS: [string, string][] = [
  ['_decimal collections numbers', 'decimal statistics'],
  ['array collections', 'array'],
  [
    'collections',
    '_ast_unparse _markupbase argparse calendar collections collections.abc contextlib difflib email._encoded_words email._header_value_parser email._policybase email.charset email.header email.headerregistry email.quoprimime email.utils fnmatch functools glob html html.entities html.parser http.cookies ipaddress json json.decoder json.encoder json.scanner optparse queue re re._casefix re._compiler re._constants re._parser sched textwrap tomllib tomllib._parser tomllib._re tomllib._types typing urllib.parse wave xml.etree.ElementPath',
  ],
  ['collections contextvars io weakref', 'asyncio asyncio.graph doctest unittest.async_case unittest.mock'],
  [
    'collections io',
    'configparser email.contentmanager email.feedparser email.message email.mime.application email.mime.audio email.mime.base email.mime.image email.mime.message email.mime.multipart email.mime.nonmultipart email.mime.text email.parser email.policy pathlib pathlib._os pickle pickletools plistlib pprint tokenize zipfile zipfile._path zipfile._path.glob',
  ],
  [
    'collections io weakref',
    '_colorize concurrent.futures dataclasses email.generator inspect logging logging.config logging.handlers pydoc tarfile traceback unittest unittest._log unittest.case unittest.loader unittest.main unittest.result unittest.runner unittest.signals unittest.suite unittest.util xml.etree.ElementInclude xml.etree.ElementTree xml.etree.cElementTree xml.sax.expatreader xml.sax.saxutils',
  ],
  ['collections numbers', 'fractions'],
  ['contextvars', 'contextvars'],
  [
    'io',
    'bz2 compression._common._streams compression.bz2 compression.lzma csv email.iterators encodings.bz2_codec io lzma shlex',
  ],
  ['io weakref', 'compression.gzip gzip xml.dom.expatbuilder xml.dom.minidom'],
  ['numbers', 'numbers'],
  ['weakref', 'copy symtable weakref xml.dom.xmlbuilder'],
];

export const REGISTERING_IMPORTS = new Map<string, string[]>(
  GROUPS.flatMap(([registering, modules]) =>
    modules.split(' ').map((name): [string, string[]] => [name, registering.split(' ')])
  )
);
