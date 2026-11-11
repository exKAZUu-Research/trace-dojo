# Prints src/python/data/unicodeData.ts: the Unicode character database of CPython's unicodedata module, read back from
# the module itself and compressed. Run with CPython 3.14: python generateUnicodeData.py > src/python/data/unicodeData.ts
import re
import sys
import unicodedata as ucd
from collections import Counter

LAST = 0x10FFFF
LINE = 116


def chunks(text):
    return [text[i : i + LINE] for i in range(0, len(text), LINE)] or ['']


def string_literal(name, doc, text):
    assert "'" not in text and '\\' not in text and all(' ' <= c <= '~' for c in text)
    lines = [f'/** {doc} */', f'export const {name} = [']
    lines += [f"  '{chunk}'," for chunk in chunks(text)]
    lines.append("].join('');")
    return '\n'.join(lines)


def b36(number):
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    text = ''
    while True:
        number, rest = divmod(number, 36)
        text = digits[rest] + text
        if number == 0:
            return text


# Properties: runs of code points sharing category, bidirectional class, East Asian width, combining class, mirrored.
records = {}
runs = []
for cp in range(LAST + 1):
    char = chr(cp)
    record = (ucd.category(char), ucd.bidirectional(char), ucd.east_asian_width(char), ucd.combining(char), ucd.mirrored(char))
    index = records.setdefault(record, len(records))
    if runs and runs[-1][1] == index:
        runs[-1][0] += 1
    else:
        runs.append([1, index])
record_text = ' '.join(f'{c} {b or "-"} {e} {k} {m}' for c, b, e, k, m in records)
assert all(m in (0, 1) for *_, m in records)
run_text = ','.join(f'{b36(length)}.{b36(index)}' for length, index in runs)

# Numeric values: decimal, digit, and numeric, the last as the repr of its float.
numeric_entries = []
previous = -1
for cp in range(LAST + 1):
    char = chr(cp)
    value = ucd.numeric(char, None)
    if value is None:
        continue
    decimal = ucd.decimal(char, None)
    digit = ucd.digit(char, None)
    kind = 'd' if decimal is not None else 'g' if digit is not None else 'n'
    assert decimal is None or decimal == digit == value
    assert digit is None or digit == value
    numeric_entries.append(f'{b36(cp - previous)}/{kind}/{repr(value)}')
    previous = cp
numeric_text = ','.join(numeric_entries)

# Decompositions, except the algorithmic ones of Hangul syllables.
tags = Counter()
decomposition_entries = []
previous = -1
for cp in range(LAST + 1):
    text = ucd.decomposition(chr(cp))
    if not text or 0xAC00 <= cp <= 0xD7A3:
        continue
    parts = text.split(' ')
    tag = parts[0][1:-1] if parts[0].startswith('<') else ''
    points = parts[1:] if tag else parts
    tags[tag] += 1
    decomposition_entries.append(f'{b36(cp - previous)}/{tag}/{".".join(b36(int(p, 16)) for p in points)}')
    previous = cp
decomposition_text = ','.join(decomposition_entries)

# Canonical pairs that NFC does not recompose.
exclusions = []
for cp in range(LAST + 1):
    text = ucd.decomposition(chr(cp))
    if not text or text.startswith('<') or 0xAC00 <= cp <= 0xD7A3:
        continue
    points = [int(p, 16) for p in text.split(' ')]
    if len(points) == 2 and ucd.normalize('NFC', ''.join(map(chr, points))) != chr(cp):
        exclusions.append(cp)
exclusion_text = ','.join(b36(cp) for cp in exclusions)

# Names: algorithmic ranges, and the others with a word dictionary.
algorithmic = []
names = {}
for cp in range(LAST + 1):
    name = ucd.name(chr(cp), None)
    if name is None:
        continue
    match = re.fullmatch(r'(.*)-([0-9A-F]{4,6})', name)
    if match and int(match.group(2), 16) == cp and match.group(1) != 'HANGUL SYLLABLE':
        prefix = match.group(1)
        if algorithmic and algorithmic[-1][2] == prefix and algorithmic[-1][1] == cp - 1:
            algorithmic[-1][1] = cp
        else:
            algorithmic.append([cp, cp, prefix])
        continue
    if name.startswith('HANGUL SYLLABLE '):
        continue
    names[cp] = name
algorithmic_text = ','.join(f'{b36(start)}.{b36(end)}.{prefix}' for start, end, prefix in algorithmic)

# Derived names that lookup() accepts although name() gives none.
lookup_only = []
for prefix in sorted({prefix for _, _, prefix in algorithmic} | {'TANGUT IDEOGRAPH'}):
    for cp in range(LAST + 1):
        if ucd.name(chr(cp), None) is not None:
            continue
        try:
            found = ucd.lookup(f'{prefix}-{cp:X}') == chr(cp)
        except KeyError:
            found = False
        if not found:
            continue
        if lookup_only and lookup_only[-1][2] == prefix and lookup_only[-1][1] == cp - 1:
            lookup_only[-1][1] = cp
        else:
            lookup_only.append([cp, cp, prefix])
lookup_only_text = ','.join(f'{b36(start)}.{b36(end)}.{prefix}' for start, end, prefix in lookup_only)

ALPHABET = [c for c in map(chr, range(0x21, 0x7F)) if c not in '!"\'\\0123456789']
assert len(ALPHABET) == 80
words = Counter(word for name in names.values() for word in name.split(' '))
order = [word for word, _ in words.most_common()]
word_index = {word: index for index, word in enumerate(order)}


def word_code(index):
    if index < 40:
        return ALPHABET[index]
    index -= 40
    if index < 30 * 80:
        return ALPHABET[40 + index // 80] + ALPHABET[index % 80]
    index -= 30 * 80
    assert index < 10 * 80 * 80
    return ALPHABET[70 + index // 6400] + ALPHABET[(index // 80) % 80] + ALPHABET[index % 80]


name_parts = []
previous = -1
previous_words = []
for cp in sorted(names):
    current = names[cp].split(' ')
    shared = 0
    while shared < min(len(current), len(previous_words), 9) and current[shared] == previous_words[shared]:
        shared += 1
    gap = '' if cp == previous + 1 else f'!{b36(cp - previous)}"'
    name_parts.append(gap + str(shared) + ''.join(word_code(word_index[word]) for word in current[shared:]))
    previous = cp
    previous_words = current
names_text = ''.join(name_parts)

# Aliases and named sequences, which CPython numbers from U+F0000 and U+F0200 and names through namereplace.
aliases = []
for cp in range(0xF0000, 0xF0200):
    replaced = chr(cp).encode('ascii', 'namereplace')
    if not replaced.startswith(b'\\N{'):
        break
    name = replaced[3:-1].decode()
    aliases.append(f'{name}:{b36(ord(ucd.lookup(name)))}')
sequences = []
for cp in range(0xF0200, 0xF0400):
    replaced = chr(cp).encode('ascii', 'namereplace')
    if not replaced.startswith(b'\\N{'):
        break
    name = replaced[3:-1].decode()
    sequences.append(f'{name}:{".".join(b36(ord(c)) for c in ucd.lookup(name))}')

print('// Generated by scripts/pythonData/generateUnicodeData.py from CPython 3.14; do not edit.')
print('// Numbers are in base 36. unicodeDatabase.ts decodes these strings when a program first needs them.')
print()
print(f"export const UNIDATA_VERSION = '{ucd.unidata_version}';")
print()
print(string_literal('PROPERTY_RECORDS', 'Category, bidirectional class, East Asian width, combining class, and mirrored, separated by spaces.', record_text))
print()
print(string_literal('PROPERTY_RUNS', 'Runs of code points from U+0000 sharing a record: the run length and the record index.', run_text))
print()
print(string_literal('NUMERIC_VALUES', 'The numeric values: the distance from the previous entry / d (decimal), g (digit) or n / the value.', numeric_text))
print()
print(string_literal('DECOMPOSITIONS', 'The decompositions: the distance from the previous entry / the tag / the code points.', decomposition_text))
print()
print(string_literal('COMPOSITION_EXCLUSIONS', 'The characters with a canonical pair decomposition that NFC does not recompose.', exclusion_text))
print()
print(string_literal('ALGORITHMIC_NAMES', 'The ranges named by a prefix and the hexadecimal code point.', algorithmic_text))
print()
print(string_literal('LOOKUP_ONLY_NAMES', 'The ranges of derived names that lookup() accepts although name() gives none.', lookup_only_text))
print()
print(string_literal('NAME_WORDS', 'The words of the names, most frequent first.', ' '.join(order)))
print()
print(string_literal('NAMES', 'The names in code point order: !distance" before a gap, the count of words shared with the previous name, and word codes.', names_text))
print()
print(string_literal('NAME_ALIASES', 'The name aliases, which lookup() and \\\\N{...} accept, with their code points.', ','.join(aliases)))
print()
print(string_literal('NAMED_SEQUENCES', 'The named sequences, which lookup() accepts, with their code points.', ','.join(sequences)))
print(f'records {len(records)} runs {len(runs)} run text {len(run_text)} numeric {len(numeric_text)} decomposition {len(decomposition_text)} exclusions {len(exclusions)} algorithmic {len(algorithmic)} words {len(" ".join(order))} names {len(names_text)} aliases {len(aliases)} sequences {len(sequences)}', file=sys.stderr)
