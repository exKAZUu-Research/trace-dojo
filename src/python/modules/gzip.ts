// CPython's gzip module and the compression package around it, which run CPython's own code.
import { registerSourceModule } from '../sourceModules';
import { COMPRESSION_STREAMS_SOURCE } from './compressionStreamsSource';
import { GZIP_SOURCE } from './gzipSource';
import { IO_BASES_SOURCE } from './ioBasesSource';

registerSourceModule('_iobases', IO_BASES_SOURCE);
registerSourceModule('compression', 'pass\n');
registerSourceModule('compression._common', 'pass\n');
registerSourceModule('compression._common._streams', COMPRESSION_STREAMS_SOURCE);
registerSourceModule('gzip', GZIP_SOURCE);
// CPython 3.14's `compression/gzip.py` and `compression/zlib.py`, which re-export the modules.
registerSourceModule('compression.gzip', 'import gzip\n__doc__ = gzip.__doc__\ndel gzip\n\nfrom gzip import *\n');
registerSourceModule('compression.zlib', 'import zlib\n__doc__ = zlib.__doc__\ndel zlib\n\nfrom zlib import *\n');
