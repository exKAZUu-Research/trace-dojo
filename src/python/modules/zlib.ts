// The checksums of zlib; compression stays unsupported.
import { bytesLikeData } from '../bytesValues';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { exceptionClassNamed, typeError, typeName } from '../types';
import type { PyValue } from '../values';
import { crc32, uint32Argument } from './binascii';
import { builtinClassWithBase } from './moduleClasses';

const zlibErrorClass = builtinClassWithBase('error', exceptionClassNamed('Exception'), 'zlib');

function checksumData(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  return data;
}

function adler32(data: Uint8Array, start: number): number {
  let low = start & 0xff_ff;
  let high = start >>> 16;
  for (const byte of data) {
    low = (low + byte) % 65_521;
    high = (high + low) % 65_521;
  }
  return ((high << 16) | low) >>> 0;
}

const CONSTANTS: [string, PyValue][] = [
  ['DEFLATED', 8n],
  ['DEF_BUF_SIZE', 16_384n],
  ['DEF_MEM_LEVEL', 8n],
  ['MAX_WBITS', 15n],
  ['ZLIB_RUNTIME_VERSION', '1.2.12'],
  ['ZLIB_VERSION', '1.2.12'],
  ['Z_BEST_COMPRESSION', 9n],
  ['Z_BEST_SPEED', 1n],
  ['Z_BLOCK', 5n],
  ['Z_DEFAULT_COMPRESSION', -1n],
  ['Z_DEFAULT_STRATEGY', 0n],
  ['Z_FILTERED', 1n],
  ['Z_FINISH', 4n],
  ['Z_FIXED', 4n],
  ['Z_FULL_FLUSH', 3n],
  ['Z_HUFFMAN_ONLY', 2n],
  ['Z_NO_COMPRESSION', 0n],
  ['Z_NO_FLUSH', 0n],
  ['Z_PARTIAL_FLUSH', 1n],
  ['Z_RLE', 3n],
  ['Z_SYNC_FLUSH', 2n],
  ['Z_TREES', 6n],
];

registerModule(
  'zlib',
  () =>
    new Map<string, PyValue>([
      ...CONSTANTS,
      [
        'adler32',
        builtin('adler32', 'expected', 1, 2, ([data, start]) =>
          BigInt(adler32(checksumData(data), start === undefined ? 1 : uint32Argument(start)))
        ),
      ],
      [
        'crc32',
        builtin('crc32', 'expected', 1, 2, ([data, start]) => BigInt(crc32(checksumData(data), uint32Argument(start)))),
      ],
      ['error', zlibErrorClass],
    ]),
  {
    compress: 'zlib.compress（データの圧縮）',
    decompress: 'zlib.decompress（データの圧縮）',
    compressobj: 'zlib.compressobj（データの圧縮）',
    decompressobj: 'zlib.decompressobj（データの圧縮）',
    _ZlibDecompressor: 'zlib._ZlibDecompressor（データの圧縮）',
  }
);
