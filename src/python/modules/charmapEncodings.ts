// The `encodings` modules of CPython's charmap codecs, such as `encodings.cp1252`, which gencodec.py generated from
// one template; this grader fills the template's tables from data/charmapCodecs.ts.
import { charmapTable } from '../charmapCodecs';
import { CHARMAP_NAMES, CHARMAP_TABLES, DICT_MAP_MODULES, ENCODING_MAP_ORDERS } from '../data/charmapCodecs';
import { registerSourceModule } from '../sourceModules';
import { newDict, None } from '../types';
import type { PyValue } from '../values';
import { addEncodingsModule } from './codecsNative';

/** The code of a gencodec.py module, whose encoder uses `encoder`: an EncodingMap, or a dict for older modules. */
const template = (encoder: string, name: string): string => String.raw`
import codecs

### Codec APIs

class Codec(codecs.Codec):

    def encode(self,input,errors='strict'):
        return codecs.charmap_encode(input,errors,${encoder})

    def decode(self,input,errors='strict'):
        return codecs.charmap_decode(input,errors,decoding_table)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.charmap_encode(input,self.errors,${encoder})[0]

class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        return codecs.charmap_decode(input,self.errors,decoding_table)[0]

class StreamWriter(Codec,codecs.StreamWriter):
    pass

class StreamReader(Codec,codecs.StreamReader):
    pass

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='${name}',
        encode=Codec().encode,
        decode=Codec().decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )

${encoder === 'encoding_table' ? 'encoding_table = codecs.charmap_build(decoding_table)' : ''}
del _c_type_name, _handled_exception, _standard_stderr, _unsupported
`;

/** The `decoding_map` and `encoding_map` dicts of a module that keeps them, as gencodec.py wrote them. */
function dictMaps(module: string, table: string): [string, PyValue][] {
  // oxlint-disable-next-line typescript/no-misused-spread -- A decoding table holds one character per byte.
  const points = [...table].map((char) => char.codePointAt(0) as number);
  const decoding = newDict(points.map((point, byte) => [BigInt(byte), point === 0xff_fe ? None : BigInt(point)]));
  const last = new Map<number, number>();
  for (const [byte, point] of points.entries()) if (point !== 0xff_fe) last.set(point, byte);
  const order = ENCODING_MAP_ORDERS[module] ?? [...last.keys()].toSorted((a, b) => a - b);
  const encoding = newDict(order.map((point) => [BigInt(point), BigInt(last.get(point) as number)]));
  return [
    ['decoding_map', decoding],
    ['encoding_map', encoding],
  ];
}

for (const module of Object.keys(CHARMAP_TABLES)) {
  const isDictModule = DICT_MAP_MODULES.has(module);
  addEncodingsModule(module);
  const name = CHARMAP_NAMES[module] ?? module;
  registerSourceModule(`encodings.${module}`, template(isDictModule ? 'encoding_map' : 'encoding_table', name), () => {
    const table = charmapTable(module);
    return new Map<string, PyValue>([['decoding_table', table], ...(isDictModule ? dictMaps(module, table) : [])]);
  });
}
