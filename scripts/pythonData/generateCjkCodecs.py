# Prints src/python/data/cjkCodecs.ts: the double-byte tables of CPython's Chinese and Korean codecs, read back from the
# codecs themselves. Run with CPython 3.14: python generateCjkCodecs.py > src/python/data/cjkCodecs.ts
#
# A table lists the characters of the cells from its first lead and trail byte to its last, row by row. Markers that
# no codec decodes to stand for runs of cells: SKIP for cells that decode to nothing, NEXT for cells that continue
# the code points of the cell before, and BASE for cells that decode as in the codec the table is based on. The
# character after a marker counts the cells.
import sys

SKIP, NEXT, BASE = '￰', '￱', '￲'
MAX_COUNT = 0xD7FF

# Each codec with its lead and trail byte ranges and the codec its table is based on.
CODECS = {
    'gbk': (0x81, 0xFE, 0x40, 0xFE, None),
    'gb2312': (0xA1, 0xF7, 0xA1, 0xFE, 'gbk'),
    'gb18030': (0x81, 0xFE, 0x40, 0xFE, 'gbk'),
    'big5': (0xA1, 0xF9, 0x40, 0xFE, None),
    'cp950': (0x81, 0xFE, 0x40, 0xFE, 'big5'),
    'big5hkscs': (0x87, 0xFE, 0x40, 0xFE, 'big5'),
    'euc_kr': (0xA1, 0xFE, 0xA1, 0xFE, None),
    'cp949': (0x81, 0xFE, 0x41, 0xFE, 'euc_kr'),
    'johab': (0x84, 0xF9, 0x31, 0xFE, None),
}


def pair_table(codec):
    """The text of each two-byte sequence the codec decodes."""
    table = {}
    for lead in range(0x80, 0x100):
        for trail in range(0x100):
            data = bytes([lead, trail])
            try:
                table[data] = data.decode(codec)
            except UnicodeDecodeError:
                pass
    return table


def cells(codec, tables):
    first_lead, last_lead, first_trail, last_trail, _ = CODECS[codec]
    table = tables[codec]
    result = []
    for lead in range(first_lead, last_lead + 1):
        for trail in range(first_trail, last_trail + 1):
            text = table.get(bytes([lead, trail]))
            result.append(text if text is not None and len(text) == 1 else None)
    return result


def encoded_cells(codec, tables):
    """The cells of a codec as its table string gives them, with the runs of markers."""
    first_lead, last_lead, first_trail, last_trail, base = CODECS[codec]
    width = last_trail - first_trail + 1
    own = cells(codec, tables)
    base_table = tables.get(base) if base else None
    tokens = []
    previous = None
    index = 0

    def run(marker, count):
        while count > 0:
            step = min(count, MAX_COUNT)
            tokens.append(marker + chr(step))
            count -= step

    while index < len(own):
        lead, trail = first_lead + index // width, first_trail + index % width
        from_base = base_table.get(bytes([lead, trail])) if base_table is not None else None
        if from_base is not None and len(from_base) != 1:
            from_base = None
        if own[index] is not None and own[index] == from_base:
            end = index
            while end < len(own):
                l, t = first_lead + end // width, first_trail + end % width
                b = base_table.get(bytes([l, t]))
                if own[end] is None or b is None or len(b) != 1 or own[end] != b:
                    break
                end += 1
            run(BASE, end - index)
            previous = own[end - 1]
            index = end
        elif own[index] is None:
            end = index
            while end < len(own) and own[end] is None:
                end += 1
            run(SKIP, end - index)
            index = end
        elif previous is not None and ord(own[index]) == ord(previous) + 1:
            end = index
            point = ord(previous)
            while end < len(own) and own[end] is not None and ord(own[end]) == point + 1:
                point += 1
                end += 1
            run(NEXT, end - index)
            previous = own[end - 1]
            index = end
        else:
            tokens.append(own[index])
            previous = own[index]
            index += 1
    return ''.join(tokens)


def decode_cells(codec, text, decoded):
    """Reads a table string back, as the TypeScript side does, to check it."""
    first_lead, last_lead, first_trail, last_trail, base = CODECS[codec]
    width = last_trail - first_trail + 1
    count = (last_lead - first_lead + 1) * width
    result = []
    previous = None
    position = 0
    while position < len(text):
        char = text[position]
        if char in (SKIP, NEXT, BASE):
            n = ord(text[position + 1])
            position += 2
            for _ in range(n):
                index = len(result)
                if char == SKIP:
                    result.append(None)
                elif char == NEXT:
                    previous = chr(ord(previous) + 1)
                    result.append(previous)
                else:
                    lead, trail = first_lead + index // width, first_trail + index % width
                    previous = decoded[base].get(bytes([lead, trail]))
                    result.append(previous)
        else:
            result.append(char)
            previous = char
            position += 1
    result += [None] * (count - len(result))
    table = {}
    for index, char in enumerate(result):
        if char is not None:
            table[bytes([first_lead + index // width, first_trail + index % width])] = char
    return table


def number(value):
    """A number as the linter wants it: in groups of three digits from five digits on."""
    return f'{value:_}' if value >= 10000 else str(value)


def escaped(text):
    out = []
    for char in text:
        point = ord(char)
        if char in "'\\" or not char.isprintable() or point >= 0xFFF0 and point <= 0xFFFF or 0xE000 <= point < 0xF900:
            out.append(f'\\u{point:04X}' if point < 0x10000 else f'\\u{{{point:X}}}')
        else:
            out.append(char)
    return ''.join(out)


def literal(text, indent='    '):
    pieces = [escaped(text[i : i + 60]) for i in range(0, len(text), 60)]
    return (',\n' + indent).join(f"'{piece}'" for piece in pieces)


tables = {codec: pair_table(codec) for codec in CODECS}
for codec in CODECS:
    for text in tables[codec].values():
        assert not any('￰' <= char <= '￲' for char in text), codec

decoded = {}
strings = {}
for codec in CODECS:
    strings[codec] = encoded_cells(codec, tables)
    decoded[codec] = decode_cells(codec, strings[codec], decoded)
    expected = {data: text for data, text in tables[codec].items() if len(text) == 1}
    assert decoded[codec] == expected, codec

multi = {codec: {data: text for data, text in tables[codec].items() if len(text) > 1} for codec in CODECS}

# The encoders: a character encodes to the last sequence that decodes to it, unless an exception says otherwise.
exceptions = {}
for codec in [*CODECS, 'hz']:
    if codec == 'hz':
        last = {text: b'~{' + bytes([data[0] & 0x7F, data[1] & 0x7F]) + b'~}' for data, text in sorted(decoded['gb2312'].items())}
    else:
        last = {}
        for data, text in sorted(decoded[codec].items()):
            last[text] = data
    found = []
    for point in range(0x80, 0x110000):
        if 0xD800 <= point < 0xE000:
            continue
        char = chr(point)
        try:
            data = char.encode(codec)
        except UnicodeEncodeError:
            data = None
        if codec == 'gb18030' and data is not None and len(data) == 4:
            continue
        if codec == 'euc_kr' and data is not None and len(data) == 8:
            continue
        if data != last.get(char):
            found.append((point, data))
    for char in last:
        try:
            char.encode(codec)
        except UnicodeEncodeError:
            found.append((ord(char), None))
    exceptions[codec] = sorted(set(found))

# GB18030's four-byte sequences for the BMP, as runs of consecutive code points by the sequence's linear index.
runs = []
for b1 in range(0x81, 0x85):
    for b2 in range(0x30, 0x3A):
        for b3 in range(0x81, 0xFF):
            for b4 in range(0x30, 0x3A):
                try:
                    text = bytes([b1, b2, b3, b4]).decode('gb18030')
                except UnicodeDecodeError:
                    continue
                index = (((b1 - 0x81) * 10 + b2 - 0x30) * 126 + b3 - 0x81) * 10 + b4 - 0x30
                point = ord(text)
                if runs and runs[-1][0] + runs[-1][2] == index and runs[-1][1] + runs[-1][2] == point:
                    runs[-1][2] += 1
                else:
                    runs.append([index, point, 1])

out = sys.stdout
out.write('// Generated by scripts/pythonData/generateCjkCodecs.py from CPython 3.14; do not edit.\n')
out.write('// A table lists the characters of the cells from its first lead and trail byte to its last, row by row: U+FFF0\n')
out.write('// and a count skip cells that decode to nothing, U+FFF1 and a count continue the code points of the cell before,\n')
out.write('// and U+FFF2 and a count take the cells of the base codec.\n\n')
out.write('export interface CjkTable {\n  leads: [number, number];\n  trails: [number, number];\n  base?: string;\n  cells: string;\n}\n\n')
out.write('/** The two-byte tables of the Chinese and Korean codecs. */\n')
out.write('export const CJK_TABLES: Record<string, CjkTable> = {\n')
for codec, (first_lead, last_lead, first_trail, last_trail, base) in CODECS.items():
    out.write(f'  {codec}: {{\n')
    out.write(f'    leads: [{first_lead}, {last_lead}],\n    trails: [{first_trail}, {last_trail}],\n')
    if base:
        out.write(f"    base: '{base}',\n")
    out.write(f'    cells: [\n      {literal(strings[codec], "      ")},\n    ].join(\'\'),\n  }},\n')
out.write('};\n\n')
out.write('/** The two-byte sequences that decode to several characters, by their bytes. */\n')
out.write('export const CJK_SEQUENCES: Record<string, [number, string][]> = {\n')
for codec, items in multi.items():
    if items:
        out.write(f'  {codec}: [\n')
        for data, text in sorted(items.items()):
            out.write(f"    [{number(int.from_bytes(data))}, '{escaped(text)}'],\n")
        out.write('  ],\n')
out.write('};\n\n')
out.write('/**\n * The characters that do not encode to the last sequence that decodes to them: the bytes they encode to, packed\n')
out.write(' * into a number, or 0 for a character the codec cannot encode.\n */\n')
out.write('export const CJK_ENCODINGS: Record<string, [number, number][]> = {\n')
for codec, items in exceptions.items():
    if items:
        out.write(f'  {codec}: [\n')
        for point, data in items:
            out.write(f'    [{number(point)}, {number(int.from_bytes(data)) if data else 0}],\n')
        out.write('  ],\n')
out.write('};\n\n')
out.write("/** GB18030's four-byte sequences for the BMP: the linear index of each run's first, its code point, and its length. */\n")
out.write('export const GB18030_RANGES = [\n')
flat = [value for run in runs for value in run]
for index in range(0, len(flat), 12):
    out.write('  ' + ' '.join(f'{number(value)},' for value in flat[index : index + 12]) + '\n')
out.write('];\n')
