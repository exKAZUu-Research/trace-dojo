import { registerSourceModule } from '../sourceModules';
import type { PyValue } from '../values';

// CPython's `encodings/ascii.py`.
const ASCII = String.raw`
""" Python 'ascii' Codec


Written by Marc-Andre Lemburg (mal@lemburg.com).

(c) Copyright CNRI, All Rights Reserved. NO WARRANTY.

"""
import codecs

### Codec APIs

class Codec(codecs.Codec):

    # Note: Binding these as C functions will result in the class not
    # converting them to methods. This is intended.
    encode = codecs.ascii_encode
    decode = codecs.ascii_decode

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.ascii_encode(input, self.errors)[0]

class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        return codecs.ascii_decode(input, self.errors)[0]

class StreamWriter(Codec,codecs.StreamWriter):
    pass

class StreamReader(Codec,codecs.StreamReader):
    pass

class StreamConverter(StreamWriter,StreamReader):

    encode = codecs.ascii_decode
    decode = codecs.ascii_encode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='ascii',
        encode=Codec.encode,
        decode=Codec.decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamwriter=StreamWriter,
        streamreader=StreamReader,
    )
`;

// CPython's `encodings/latin_1.py`.
const LATIN_1 = String.raw`
""" Python 'latin-1' Codec


Written by Marc-Andre Lemburg (mal@lemburg.com).

(c) Copyright CNRI, All Rights Reserved. NO WARRANTY.

"""
import codecs

### Codec APIs

class Codec(codecs.Codec):

    # Note: Binding these as C functions will result in the class not
    # converting them to methods. This is intended.
    encode = codecs.latin_1_encode
    decode = codecs.latin_1_decode

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.latin_1_encode(input,self.errors)[0]

class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        return codecs.latin_1_decode(input,self.errors)[0]

class StreamWriter(Codec,codecs.StreamWriter):
    pass

class StreamReader(Codec,codecs.StreamReader):
    pass

class StreamConverter(StreamWriter,StreamReader):

    encode = codecs.latin_1_decode
    decode = codecs.latin_1_encode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='iso8859-1',
        encode=Codec.encode,
        decode=Codec.decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_8.py`.
const UTF_8 = String.raw`
""" Python 'utf-8' Codec


Written by Marc-Andre Lemburg (mal@lemburg.com).

(c) Copyright CNRI, All Rights Reserved. NO WARRANTY.

"""
import codecs

### Codec APIs

encode = codecs.utf_8_encode

def decode(input, errors='strict'):
    return codecs.utf_8_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.utf_8_encode(input, self.errors)[0]

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    _buffer_decode = codecs.utf_8_decode

class StreamWriter(codecs.StreamWriter):
    encode = codecs.utf_8_encode

class StreamReader(codecs.StreamReader):
    decode = codecs.utf_8_decode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-8',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_8_sig.py`.
const UTF_8_SIG = String.raw`
""" Python 'utf-8-sig' Codec
This work similar to UTF-8 with the following changes:

* On encoding/writing a UTF-8 encoded BOM will be prepended/written as the
  first three bytes.

* On decoding/reading if the first three bytes are a UTF-8 encoded BOM, these
  bytes will be skipped.
"""
import codecs

### Codec APIs

def encode(input, errors='strict'):
    return (codecs.BOM_UTF8 + codecs.utf_8_encode(input, errors)[0],
            len(input))

def decode(input, errors='strict'):
    prefix = 0
    if input[:3] == codecs.BOM_UTF8:
        input = input[3:]
        prefix = 3
    (output, consumed) = codecs.utf_8_decode(input, errors, True)
    return (output, consumed+prefix)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def __init__(self, errors='strict'):
        codecs.IncrementalEncoder.__init__(self, errors)
        self.first = 1

    def encode(self, input, final=False):
        if self.first:
            self.first = 0
            return codecs.BOM_UTF8 + \
                   codecs.utf_8_encode(input, self.errors)[0]
        else:
            return codecs.utf_8_encode(input, self.errors)[0]

    def reset(self):
        codecs.IncrementalEncoder.reset(self)
        self.first = 1

    def getstate(self):
        return self.first

    def setstate(self, state):
        self.first = state

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    def __init__(self, errors='strict'):
        codecs.BufferedIncrementalDecoder.__init__(self, errors)
        self.first = 1

    def _buffer_decode(self, input, errors, final):
        if self.first:
            if len(input) < 3:
                if codecs.BOM_UTF8.startswith(input):
                    # not enough data to decide if this really is a BOM
                    # => try again on the next call
                    return ("", 0)
                else:
                    self.first = 0
            else:
                self.first = 0
                if input[:3] == codecs.BOM_UTF8:
                    (output, consumed) = \
                       codecs.utf_8_decode(input[3:], errors, final)
                    return (output, consumed+3)
        return codecs.utf_8_decode(input, errors, final)

    def reset(self):
        codecs.BufferedIncrementalDecoder.reset(self)
        self.first = 1

    def getstate(self):
        state = codecs.BufferedIncrementalDecoder.getstate(self)
        # state[1] must be 0 here, as it isn't passed along to the caller
        return (state[0], self.first)

    def setstate(self, state):
        # state[1] will be ignored by BufferedIncrementalDecoder.setstate()
        codecs.BufferedIncrementalDecoder.setstate(self, state)
        self.first = state[1]

class StreamWriter(codecs.StreamWriter):
    def reset(self):
        codecs.StreamWriter.reset(self)
        try:
            del self.encode
        except AttributeError:
            pass

    def encode(self, input, errors='strict'):
        self.encode = codecs.utf_8_encode
        return encode(input, errors)

class StreamReader(codecs.StreamReader):
    def reset(self):
        codecs.StreamReader.reset(self)
        try:
            del self.decode
        except AttributeError:
            pass

    def decode(self, input, errors='strict'):
        if len(input) < 3:
            if codecs.BOM_UTF8.startswith(input):
                # not enough data to decide if this is a BOM
                # => try again on the next call
                return ("", 0)
        elif input[:3] == codecs.BOM_UTF8:
            self.decode = codecs.utf_8_decode
            (output, consumed) = codecs.utf_8_decode(input[3:],errors)
            return (output, consumed+3)
        # (else) no BOM present
        self.decode = codecs.utf_8_decode
        return codecs.utf_8_decode(input, errors)

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-8-sig',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_16.py`.
const UTF_16 = String.raw`
""" Python 'utf-16' Codec


Written by Marc-Andre Lemburg (mal@lemburg.com).

(c) Copyright CNRI, All Rights Reserved. NO WARRANTY.

"""
import codecs, sys

### Codec APIs

encode = codecs.utf_16_encode

def decode(input, errors='strict'):
    return codecs.utf_16_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def __init__(self, errors='strict'):
        codecs.IncrementalEncoder.__init__(self, errors)
        self.encoder = None

    def encode(self, input, final=False):
        if self.encoder is None:
            result = codecs.utf_16_encode(input, self.errors)[0]
            if sys.byteorder == 'little':
                self.encoder = codecs.utf_16_le_encode
            else:
                self.encoder = codecs.utf_16_be_encode
            return result
        return self.encoder(input, self.errors)[0]

    def reset(self):
        codecs.IncrementalEncoder.reset(self)
        self.encoder = None

    def getstate(self):
        # state info we return to the caller:
        # 0: stream is in natural order for this platform
        # 2: endianness hasn't been determined yet
        # (we're never writing in unnatural order)
        return (2 if self.encoder is None else 0)

    def setstate(self, state):
        if state:
            self.encoder = None
        else:
            if sys.byteorder == 'little':
                self.encoder = codecs.utf_16_le_encode
            else:
                self.encoder = codecs.utf_16_be_encode

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    def __init__(self, errors='strict'):
        codecs.BufferedIncrementalDecoder.__init__(self, errors)
        self.decoder = None

    def _buffer_decode(self, input, errors, final):
        if self.decoder is None:
            (output, consumed, byteorder) = \
                codecs.utf_16_ex_decode(input, errors, 0, final)
            if byteorder == -1:
                self.decoder = codecs.utf_16_le_decode
            elif byteorder == 1:
                self.decoder = codecs.utf_16_be_decode
            elif consumed >= 2:
                raise UnicodeDecodeError("utf-16", input, 0, 2, "Stream does not start with BOM")
            return (output, consumed)
        return self.decoder(input, self.errors, final)

    def reset(self):
        codecs.BufferedIncrementalDecoder.reset(self)
        self.decoder = None

    def getstate(self):
        # additional state info from the base class must be None here,
        # as it isn't passed along to the caller
        state = codecs.BufferedIncrementalDecoder.getstate(self)[0]
        # additional state info we pass to the caller:
        # 0: stream is in natural order for this platform
        # 1: stream is in unnatural order
        # 2: endianness hasn't been determined yet
        if self.decoder is None:
            return (state, 2)
        addstate = int((sys.byteorder == "big") !=
                       (self.decoder is codecs.utf_16_be_decode))
        return (state, addstate)

    def setstate(self, state):
        # state[1] will be ignored by BufferedIncrementalDecoder.setstate()
        codecs.BufferedIncrementalDecoder.setstate(self, state)
        state = state[1]
        if state == 0:
            self.decoder = (codecs.utf_16_be_decode
                            if sys.byteorder == "big"
                            else codecs.utf_16_le_decode)
        elif state == 1:
            self.decoder = (codecs.utf_16_le_decode
                            if sys.byteorder == "big"
                            else codecs.utf_16_be_decode)
        else:
            self.decoder = None

class StreamWriter(codecs.StreamWriter):
    def __init__(self, stream, errors='strict'):
        codecs.StreamWriter.__init__(self, stream, errors)
        self.encoder = None

    def reset(self):
        codecs.StreamWriter.reset(self)
        self.encoder = None

    def encode(self, input, errors='strict'):
        if self.encoder is None:
            result = codecs.utf_16_encode(input, errors)
            if sys.byteorder == 'little':
                self.encoder = codecs.utf_16_le_encode
            else:
                self.encoder = codecs.utf_16_be_encode
            return result
        else:
            return self.encoder(input, errors)

class StreamReader(codecs.StreamReader):

    def reset(self):
        codecs.StreamReader.reset(self)
        try:
            del self.decode
        except AttributeError:
            pass

    def decode(self, input, errors='strict'):
        (object, consumed, byteorder) = \
            codecs.utf_16_ex_decode(input, errors, 0, False)
        if byteorder == -1:
            self.decode = codecs.utf_16_le_decode
        elif byteorder == 1:
            self.decode = codecs.utf_16_be_decode
        elif consumed>=2:
            raise UnicodeDecodeError("utf-16", input, 0, 2, "Stream does not start with BOM")
        return (object, consumed)

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-16',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_16_le.py`.
const UTF_16_LE = String.raw`
""" Python 'utf-16-le' Codec


Written by Marc-Andre Lemburg (mal@lemburg.com).

(c) Copyright CNRI, All Rights Reserved. NO WARRANTY.

"""
import codecs

### Codec APIs

encode = codecs.utf_16_le_encode

def decode(input, errors='strict'):
    return codecs.utf_16_le_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.utf_16_le_encode(input, self.errors)[0]

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    _buffer_decode = codecs.utf_16_le_decode

class StreamWriter(codecs.StreamWriter):
    encode = codecs.utf_16_le_encode

class StreamReader(codecs.StreamReader):
    decode = codecs.utf_16_le_decode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-16-le',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_16_be.py`.
const UTF_16_BE = String.raw`
""" Python 'utf-16-be' Codec


Written by Marc-Andre Lemburg (mal@lemburg.com).

(c) Copyright CNRI, All Rights Reserved. NO WARRANTY.

"""
import codecs

### Codec APIs

encode = codecs.utf_16_be_encode

def decode(input, errors='strict'):
    return codecs.utf_16_be_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.utf_16_be_encode(input, self.errors)[0]

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    _buffer_decode = codecs.utf_16_be_decode

class StreamWriter(codecs.StreamWriter):
    encode = codecs.utf_16_be_encode

class StreamReader(codecs.StreamReader):
    decode = codecs.utf_16_be_decode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-16-be',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_32.py`.
const UTF_32 = String.raw`
"""
Python 'utf-32' Codec
"""
import codecs, sys

### Codec APIs

encode = codecs.utf_32_encode

def decode(input, errors='strict'):
    return codecs.utf_32_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def __init__(self, errors='strict'):
        codecs.IncrementalEncoder.__init__(self, errors)
        self.encoder = None

    def encode(self, input, final=False):
        if self.encoder is None:
            result = codecs.utf_32_encode(input, self.errors)[0]
            if sys.byteorder == 'little':
                self.encoder = codecs.utf_32_le_encode
            else:
                self.encoder = codecs.utf_32_be_encode
            return result
        return self.encoder(input, self.errors)[0]

    def reset(self):
        codecs.IncrementalEncoder.reset(self)
        self.encoder = None

    def getstate(self):
        # state info we return to the caller:
        # 0: stream is in natural order for this platform
        # 2: endianness hasn't been determined yet
        # (we're never writing in unnatural order)
        return (2 if self.encoder is None else 0)

    def setstate(self, state):
        if state:
            self.encoder = None
        else:
            if sys.byteorder == 'little':
                self.encoder = codecs.utf_32_le_encode
            else:
                self.encoder = codecs.utf_32_be_encode

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    def __init__(self, errors='strict'):
        codecs.BufferedIncrementalDecoder.__init__(self, errors)
        self.decoder = None

    def _buffer_decode(self, input, errors, final):
        if self.decoder is None:
            (output, consumed, byteorder) = \
                codecs.utf_32_ex_decode(input, errors, 0, final)
            if byteorder == -1:
                self.decoder = codecs.utf_32_le_decode
            elif byteorder == 1:
                self.decoder = codecs.utf_32_be_decode
            elif consumed >= 4:
                raise UnicodeDecodeError("utf-32", input, 0, 4, "Stream does not start with BOM")
            return (output, consumed)
        return self.decoder(input, self.errors, final)

    def reset(self):
        codecs.BufferedIncrementalDecoder.reset(self)
        self.decoder = None

    def getstate(self):
        # additional state info from the base class must be None here,
        # as it isn't passed along to the caller
        state = codecs.BufferedIncrementalDecoder.getstate(self)[0]
        # additional state info we pass to the caller:
        # 0: stream is in natural order for this platform
        # 1: stream is in unnatural order
        # 2: endianness hasn't been determined yet
        if self.decoder is None:
            return (state, 2)
        addstate = int((sys.byteorder == "big") !=
                       (self.decoder is codecs.utf_32_be_decode))
        return (state, addstate)

    def setstate(self, state):
        # state[1] will be ignored by BufferedIncrementalDecoder.setstate()
        codecs.BufferedIncrementalDecoder.setstate(self, state)
        state = state[1]
        if state == 0:
            self.decoder = (codecs.utf_32_be_decode
                            if sys.byteorder == "big"
                            else codecs.utf_32_le_decode)
        elif state == 1:
            self.decoder = (codecs.utf_32_le_decode
                            if sys.byteorder == "big"
                            else codecs.utf_32_be_decode)
        else:
            self.decoder = None

class StreamWriter(codecs.StreamWriter):
    def __init__(self, stream, errors='strict'):
        self.encoder = None
        codecs.StreamWriter.__init__(self, stream, errors)

    def reset(self):
        codecs.StreamWriter.reset(self)
        self.encoder = None

    def encode(self, input, errors='strict'):
        if self.encoder is None:
            result = codecs.utf_32_encode(input, errors)
            if sys.byteorder == 'little':
                self.encoder = codecs.utf_32_le_encode
            else:
                self.encoder = codecs.utf_32_be_encode
            return result
        else:
            return self.encoder(input, errors)

class StreamReader(codecs.StreamReader):

    def reset(self):
        codecs.StreamReader.reset(self)
        try:
            del self.decode
        except AttributeError:
            pass

    def decode(self, input, errors='strict'):
        (object, consumed, byteorder) = \
            codecs.utf_32_ex_decode(input, errors, 0, False)
        if byteorder == -1:
            self.decode = codecs.utf_32_le_decode
        elif byteorder == 1:
            self.decode = codecs.utf_32_be_decode
        elif consumed >= 4:
            raise UnicodeDecodeError("utf-32", input, 0, 4, "Stream does not start with BOM")
        return (object, consumed)

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-32',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_32_le.py`.
const UTF_32_LE = String.raw`
"""
Python 'utf-32-le' Codec
"""
import codecs

### Codec APIs

encode = codecs.utf_32_le_encode

def decode(input, errors='strict'):
    return codecs.utf_32_le_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.utf_32_le_encode(input, self.errors)[0]

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    _buffer_decode = codecs.utf_32_le_decode

class StreamWriter(codecs.StreamWriter):
    encode = codecs.utf_32_le_encode

class StreamReader(codecs.StreamReader):
    decode = codecs.utf_32_le_decode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-32-le',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/utf_32_be.py`.
const UTF_32_BE = String.raw`
"""
Python 'utf-32-be' Codec
"""
import codecs

### Codec APIs

encode = codecs.utf_32_be_encode

def decode(input, errors='strict'):
    return codecs.utf_32_be_decode(input, errors, True)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.utf_32_be_encode(input, self.errors)[0]

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    _buffer_decode = codecs.utf_32_be_decode

class StreamWriter(codecs.StreamWriter):
    encode = codecs.utf_32_be_encode

class StreamReader(codecs.StreamReader):
    decode = codecs.utf_32_be_decode

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='utf-32-be',
        encode=encode,
        decode=decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings/rot_13.py`.
const ROT_13 = String.raw`
#!/usr/bin/env python
""" Python Character Mapping Codec for ROT13.

This codec de/encodes from str to str.

Written by Marc-Andre Lemburg (mal@lemburg.com).
"""

import codecs

### Codec APIs

class Codec(codecs.Codec):
    def encode(self, input, errors='strict'):
        return (str.translate(input, rot13_map), len(input))

    def decode(self, input, errors='strict'):
        return (str.translate(input, rot13_map), len(input))

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return str.translate(input, rot13_map)

class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        return str.translate(input, rot13_map)

class StreamWriter(Codec,codecs.StreamWriter):
    pass

class StreamReader(Codec,codecs.StreamReader):
    pass

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='rot-13',
        encode=Codec().encode,
        decode=Codec().decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamwriter=StreamWriter,
        streamreader=StreamReader,
        _is_text_encoding=False,
    )

### Map

rot13_map = codecs.make_identity_dict(range(256))
rot13_map.update({
   0x0041: 0x004e,
   0x0042: 0x004f,
   0x0043: 0x0050,
   0x0044: 0x0051,
   0x0045: 0x0052,
   0x0046: 0x0053,
   0x0047: 0x0054,
   0x0048: 0x0055,
   0x0049: 0x0056,
   0x004a: 0x0057,
   0x004b: 0x0058,
   0x004c: 0x0059,
   0x004d: 0x005a,
   0x004e: 0x0041,
   0x004f: 0x0042,
   0x0050: 0x0043,
   0x0051: 0x0044,
   0x0052: 0x0045,
   0x0053: 0x0046,
   0x0054: 0x0047,
   0x0055: 0x0048,
   0x0056: 0x0049,
   0x0057: 0x004a,
   0x0058: 0x004b,
   0x0059: 0x004c,
   0x005a: 0x004d,
   0x0061: 0x006e,
   0x0062: 0x006f,
   0x0063: 0x0070,
   0x0064: 0x0071,
   0x0065: 0x0072,
   0x0066: 0x0073,
   0x0067: 0x0074,
   0x0068: 0x0075,
   0x0069: 0x0076,
   0x006a: 0x0077,
   0x006b: 0x0078,
   0x006c: 0x0079,
   0x006d: 0x007a,
   0x006e: 0x0061,
   0x006f: 0x0062,
   0x0070: 0x0063,
   0x0071: 0x0064,
   0x0072: 0x0065,
   0x0073: 0x0066,
   0x0074: 0x0067,
   0x0075: 0x0068,
   0x0076: 0x0069,
   0x0077: 0x006a,
   0x0078: 0x006b,
   0x0079: 0x006c,
   0x007a: 0x006d,
})

### Filter API

def rot13(infile, outfile):
    outfile.write(codecs.encode(infile.read(), 'rot-13'))

if __name__ == '__main__':
    import sys
    rot13(sys.stdin, sys.stdout)
`;

// CPython's `encodings/hex_codec.py`.
const HEX_CODEC = String.raw`
"""Python 'hex_codec' Codec - 2-digit hex content transfer encoding.

This codec de/encodes from bytes to bytes.

Written by Marc-Andre Lemburg (mal@lemburg.com).
"""

import codecs
import binascii

### Codec APIs

def hex_encode(input, errors='strict'):
    assert errors == 'strict'
    return (binascii.b2a_hex(input), len(input))

def hex_decode(input, errors='strict'):
    assert errors == 'strict'
    return (binascii.a2b_hex(input), len(input))

class Codec(codecs.Codec):
    def encode(self, input, errors='strict'):
        return hex_encode(input, errors)
    def decode(self, input, errors='strict'):
        return hex_decode(input, errors)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        assert self.errors == 'strict'
        return binascii.b2a_hex(input)

class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        assert self.errors == 'strict'
        return binascii.a2b_hex(input)

class StreamWriter(Codec, codecs.StreamWriter):
    charbuffertype = bytes

class StreamReader(Codec, codecs.StreamReader):
    charbuffertype = bytes

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='hex',
        encode=hex_encode,
        decode=hex_decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamwriter=StreamWriter,
        streamreader=StreamReader,
        _is_text_encoding=False,
    )
`;

// CPython's `encodings/base64_codec.py`.
const BASE64_CODEC = String.raw`
"""Python 'base64_codec' Codec - base64 content transfer encoding.

This codec de/encodes from bytes to bytes.

Written by Marc-Andre Lemburg (mal@lemburg.com).
"""

import codecs
import base64

### Codec APIs

def base64_encode(input, errors='strict'):
    assert errors == 'strict'
    return (base64.encodebytes(input), len(input))

def base64_decode(input, errors='strict'):
    assert errors == 'strict'
    return (base64.decodebytes(input), len(input))

class Codec(codecs.Codec):
    def encode(self, input, errors='strict'):
        return base64_encode(input, errors)
    def decode(self, input, errors='strict'):
        return base64_decode(input, errors)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        assert self.errors == 'strict'
        return base64.encodebytes(input)

class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        assert self.errors == 'strict'
        return base64.decodebytes(input)

class StreamWriter(Codec, codecs.StreamWriter):
    charbuffertype = bytes

class StreamReader(Codec, codecs.StreamReader):
    charbuffertype = bytes

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='base64',
        encode=base64_encode,
        decode=base64_decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamwriter=StreamWriter,
        streamreader=StreamReader,
        _is_text_encoding=False,
    )
`;

// CPython's `encodings/zlib_codec.py`.
const ZLIB_CODEC = String.raw`
"""Python 'zlib_codec' Codec - zlib compression encoding.

This codec de/encodes from bytes to bytes.

Written by Marc-Andre Lemburg (mal@lemburg.com).
"""

import codecs
import zlib # this codec needs the optional zlib module !

### Codec APIs

def zlib_encode(input, errors='strict'):
    assert errors == 'strict'
    return (zlib.compress(input), len(input))

def zlib_decode(input, errors='strict'):
    assert errors == 'strict'
    return (zlib.decompress(input), len(input))

class Codec(codecs.Codec):
    def encode(self, input, errors='strict'):
        return zlib_encode(input, errors)
    def decode(self, input, errors='strict'):
        return zlib_decode(input, errors)

class IncrementalEncoder(codecs.IncrementalEncoder):
    def __init__(self, errors='strict'):
        assert errors == 'strict'
        self.errors = errors
        self.compressobj = zlib.compressobj()

    def encode(self, input, final=False):
        if final:
            c = self.compressobj.compress(input)
            return c + self.compressobj.flush()
        else:
            return self.compressobj.compress(input)

    def reset(self):
        self.compressobj = zlib.compressobj()

class IncrementalDecoder(codecs.IncrementalDecoder):
    def __init__(self, errors='strict'):
        assert errors == 'strict'
        self.errors = errors
        self.decompressobj = zlib.decompressobj()

    def decode(self, input, final=False):
        if final:
            c = self.decompressobj.decompress(input)
            return c + self.decompressobj.flush()
        else:
            return self.decompressobj.decompress(input)

    def reset(self):
        self.decompressobj = zlib.decompressobj()

class StreamWriter(Codec, codecs.StreamWriter):
    charbuffertype = bytes

class StreamReader(Codec, codecs.StreamReader):
    charbuffertype = bytes

### encodings module API

def getregentry():
    return codecs.CodecInfo(
        name='zlib',
        encode=zlib_encode,
        decode=zlib_decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
        _is_text_encoding=False,
    )
`;

// The modules of CPython's Japanese codecs, which CPython writes over its C modules `_codecs_jp` and
// `_multibytecodec`, over this grader's codecs instead. ISO-2022-JP keeps a shift state between calls, which
// converting piece by piece would lose, so only its whole-text conversions are supported.
const MULTIBYTE = String.raw`
import _codecs, codecs

# Stands for the codec object of CPython's _multibytecodec module.
class _MultibyteCodec:
    def __init__(self, name):
        self._name = name

    def encode(self, input, errors=None):
        return _codecs._encode_with(self._name, input, errors)

    def decode(self, input, errors=None):
        return _codecs._decode_with(self._name, input, errors, True)


codec = _MultibyteCodec(_NAME)

class Codec(codecs.Codec):
    encode = codec.encode
    decode = codec.decode

class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        if _STATEFUL:
            _unsupported('ISO-2022-JP \u306E\u5C11\u3057\u305A\u3064\u306E\u7B26\u53F7\u5316\uFF08codecs \u306E IncrementalEncoder\u30FBStreamWriter\uFF09')
        return codec.encode(input, self.errors)[0]

class IncrementalDecoder(codecs.BufferedIncrementalDecoder):
    def _buffer_decode(self, input, errors, final):
        return _codecs._decode_with(_NAME, input, errors, final)

class StreamReader(Codec, codecs.StreamReader):
    def decode(self, input, errors='strict'):
        return _codecs._decode_with(_NAME, input, errors, False)

class StreamWriter(Codec, codecs.StreamWriter):
    def encode(self, input, errors='strict'):
        if _STATEFUL:
            _unsupported('ISO-2022-JP \u306E\u5C11\u3057\u305A\u3064\u306E\u7B26\u53F7\u5316\uFF08codecs \u306E IncrementalEncoder\u30FBStreamWriter\uFF09')
        return codec.encode(input, errors)

def getregentry():
    return codecs.CodecInfo(
        name=_NAME,
        encode=Codec().encode,
        decode=Codec().decode,
        incrementalencoder=IncrementalEncoder,
        incrementaldecoder=IncrementalDecoder,
        streamreader=StreamReader,
        streamwriter=StreamWriter,
    )
`;

// CPython's `encodings` package finds codecs for `_codecs.lookup`, which this grader's `_codecs` does itself.
registerSourceModule('encodings', '');
registerSourceModule('encodings.ascii', ASCII);
registerSourceModule('encodings.latin_1', LATIN_1);
registerSourceModule('encodings.utf_8', UTF_8);
registerSourceModule('encodings.utf_8_sig', UTF_8_SIG);
registerSourceModule('encodings.utf_16', UTF_16);
registerSourceModule('encodings.utf_16_le', UTF_16_LE);
registerSourceModule('encodings.utf_16_be', UTF_16_BE);
registerSourceModule('encodings.utf_32', UTF_32);
registerSourceModule('encodings.utf_32_le', UTF_32_LE);
registerSourceModule('encodings.utf_32_be', UTF_32_BE);
registerSourceModule('encodings.rot_13', ROT_13);
registerSourceModule('encodings.hex_codec', HEX_CODEC);
registerSourceModule('encodings.base64_codec', BASE64_CODEC);
registerSourceModule('encodings.zlib_codec', ZLIB_CODEC);
for (const name of ['shift_jis', 'cp932', 'euc_jp', 'iso2022_jp']) {
  registerSourceModule(
    `encodings.${name}`,
    MULTIBYTE,
    () =>
      new Map<string, PyValue>([
        ['_NAME', name],
        ['_STATEFUL', name === 'iso2022_jp'],
      ])
  );
}
