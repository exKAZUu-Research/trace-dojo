import { method } from '../define';
import { registerExtraAttributes, registerSharedAttributes, registerUnsupportedAttributes } from '../modules';
import { callValue, getAttribute } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { builtinClass, bytearrayClass, bytesClass, nativeFunction, newTuple, None, objectClass } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyOpaque, type PyValue } from '../values';
import { COPYRIGHT } from './sysHooks';

// The names CPython's modules have that the code of their implementations here does not define: names the module
// imported from another one, which are the same objects, and constants. A module's own file registers its other names.

registerSharedAttributes('io', { GenericAlias: 'types:GenericAlias' });
registerSharedAttributes('doctest', { IncrementalNewlineDecoder: 'io:IncrementalNewlineDecoder' });
registerSharedAttributes('email.parser', { TextIOWrapper: 'io:TextIOWrapper' });
registerSharedAttributes('tokenize', { TextIOWrapper: 'io:TextIOWrapper' });
registerSharedAttributes('numbers', { ABCMeta: 'abc:ABCMeta', abstractmethod: 'abc:abstractmethod' });
registerSharedAttributes('concurrent.futures', { TimeoutError: 'builtins:TimeoutError' });
registerSharedAttributes('traceback', { suppress: 'contextlib:suppress' });
registerSharedAttributes('unittest.mock', { Format: 'annotationlib:Format', fields: 'dataclasses:fields' });
registerSharedAttributes('statistics', {
  Counter: 'collections:Counter',
  Decimal: 'decimal:Decimal',
  Fraction: 'fractions:Fraction',
  count: 'itertools:count',
  defaultdict: 'collections:defaultdict',
  erfc: 'math:erfc',
  fabs: 'math:fabs',
  fsum: 'math:fsum',
  groupby: 'itertools:groupby',
  hypot: 'math:hypot',
  isfinite: 'math:isfinite',
  isinf: 'math:isinf',
  itemgetter: 'operator:itemgetter',
  namedtuple: 'collections:namedtuple',
  reduce: 'functools:reduce',
  repeat: 'itertools:repeat',
});
registerSharedAttributes('_csv', { Reader: '_csv:_reader_type', Writer: '_csv:_writer_type' });

registerExtraAttributes('io', () => [
  [
    '__author__',
    'Guido van Rossum <guido@python.org>, Mike Verdone <mike.verdone@gmail.com>, Mark Russell ' +
      "<mark.russell@zen.co.uk>, Antoine Pitrou <solipsis@pitrou.net>, Amaury Forgeot d'Arc <amauryfa@gmail.com>, " +
      'Benjamin Peterson <benjamin@python.org>',
  ],
]);
registerExtraAttributes('inspect', () => [
  ['__author__', newTuple(['Ka-Ping Yee <ping@lfw.org>', 'Yury Selivanov <yselivanov@sprymix.com>'])],
]);
registerExtraAttributes('concurrent.futures', () => [['__author__', 'Brian Quinlan (brian@sweetapp.com)']]);
registerExtraAttributes('traceback', () => [['BUILTIN_EXCEPTION_LIMIT', callValue(objectClass, [])]]);
registerExtraAttributes('base64', () => [
  ['MAXLINESIZE', 76n],
  ['MAXBINSIZE', 57n],
  ['bytes_types', newTuple([bytesClass, bytearrayClass])],
]);
registerExtraAttributes('decimal', () => [
  ['__version__', '1.70'],
  ['__libmpdec_version__', '4.0.0'],
]);
registerExtraAttributes('re', () => [['__version__', '2.2.1']]);
// importlib's own function, which imports as the builtin `__import__` does.
registerExtraAttributes('importlib', (runtime) => [
  [
    '__import__',
    nativeFunction('__import__', (args, kwargs) =>
      callValue(runtime.builtins.get('__import__') as PyValue, args, kwargs)
    ),
  ],
]);
// compression.zlib copies zlib's docstring.
registerExtraAttributes('zlib', () => [
  [
    '__doc__',
    `The functions in this module allow compression and decompression using the
zlib library, which is based on GNU zip.

adler32(string[, start]) -- Compute an Adler-32 checksum.
compress(data[, level]) -- Compress data, with compression level 0-9 or -1.
compressobj([level[, ...]]) -- Return a compressor object.
crc32(string[, start]) -- Compute a CRC-32 checksum.
decompress(string,[wbits],[bufsize]) -- Decompresses a compressed string.
decompressobj([wbits[, zdict]]) -- Return a decompressor object.

'wbits' is window buffer size and container format.
Compressor objects support compress() and flush() methods; decompressor
objects support decompress() and flush().`,
  ],
]);
// errno.ECONNRESET on macOS.
registerExtraAttributes('logging.config', () => [['RESET_ERROR', 54n]]);

registerUnsupportedAttributes('base64', { main: 'コマンドライン引数（base64.main()）' });
registerUnsupportedAttributes('logging.config', {
  StreamRequestHandler: 'ネットワーク（logging.config.StreamRequestHandler）',
  ThreadingTCPServer: 'ネットワーク（logging.config.ThreadingTCPServer）',
});
registerUnsupportedAttributes('datetime', {
  datetime_CAPI: 'C の拡張モジュールのためのカプセル（datetime.datetime_CAPI）',
});
registerUnsupportedAttributes('_thread', {
  interrupt_main: 'シグナル（_thread.interrupt_main()）',
  start_joinable_thread: 'CPython の threading の内部の関数（_thread.start_joinable_thread()）',
});
registerUnsupportedAttributes('tomllib._parser', {
  __conditional_annotations__: 'モジュールの __conditional_annotations__',
});

// builtins: the license printers of CPython's site module ------------------------------------------------------------

const printerClass = builtinClass('_Printer');
printerClass.module = '_sitebuiltins';
printerClass.dict.set('MAXLINES', 23n);

const CREDITS = `Thanks to CWI, CNRI, BeOpen, Zope Corporation, the Python Software
Foundation, and a cast of thousands for supporting Python
development.  See www.python.org for more information.`;

/** A `_Printer` showing `text`, or, for undefined, the license, which CPython reads from its LICENSE file. */
function printer(text: string | undefined): PyOpaque {
  return new PyOpaque(printerClass, text ?? 'Type license() to see the full license text', text === undefined);
}

method(printerClass, '__repr__', 'none', 0, 0, (self) => (self as PyOpaque).text);
// Without a terminal, CPython's pager writes the text as it is, with no newline after it.
method(printerClass, '__call__', 'none', 0, 0, (self) => {
  const { text, data } = self as PyOpaque;
  if (data === true) throw new UnsupportedFeatureError('ライセンスの全文（license()、CPython のファイルから読む）');
  const stdout = currentRuntime().importModule('sys').dict.get('stdout') as PyValue;
  callValue(getAttribute(stdout, 'write'), [text]);
  return None;
});

registerExtraAttributes('builtins', () => [
  ['copyright', printer(COPYRIGHT)],
  ['credits', printer(CREDITS)],
  ['license', printer(undefined)],
]);
