// code-gauge-allow-file duplicateLines 747 -- The CPython sources it holds share code with others this grader holds.
import { PyBytes } from '../../bytesValues';
import { builtin } from '../../define';
import { registerModule } from '../../modules';
import { toIndex } from '../../numbers';
import { registerSourceModule } from '../../sourceModules';
import { unbox } from '../../types';
import { UnsupportedFeatureError } from '../../unsupported';
import type { PyValue } from '../../values';
import { MAXGROUPS, MAXREPEAT } from './constants';
import { compileRegex } from './pattern';
import { asciiIsCased, asciiLower, unicodeIsCased, unicodeLower } from './unicodeData';

// CPython's `_sre` for the Python parts of `re` below: the compiled code they make is not what this grader's engine
// runs, so `compile` compiles the pattern's text again, without printing what `re.DEBUG` printed already.
registerModule('_sre', () => {
  return new Map<string, PyValue>([
    ['MAGIC', 20_230_612n],
    ['CODESIZE', 4n],
    ['MAXREPEAT', BigInt(MAXREPEAT)],
    ['MAXGROUPS', BigInt(MAXGROUPS)],
    ['copyright', ' SRE 2.2.2 Copyright (c) 1997-2002 by Secret Labs AB '],
    ['getcodesize', builtin('getcodesize', 'none', 0, 0, () => 4n)],
    ['ascii_iscased', character('ascii_iscased', asciiIsCased)],
    ['unicode_iscased', character('unicode_iscased', unicodeIsCased)],
    ['ascii_tolower', character('ascii_tolower', (code) => BigInt(asciiLower(code)))],
    ['unicode_tolower', character('unicode_tolower', (code) => BigInt(unicodeLower(code)))],
    [
      'compile',
      builtin('compile', 'takes', 6, 6, ([pattern, flags]) => {
        if (!(pattern instanceof PyBytes) && typeof unbox(pattern as PyValue) !== 'string') {
          throw new UnsupportedFeatureError('解析済みのパターン（SubPattern）のコンパイル');
        }
        const value = Number(BigInt.asIntN(32, toIndex(flags as PyValue)));
        return compileRegex(pattern as PyValue, value, false);
      }),
    ],
    [
      'template',
      builtin('template', 'expected', 2, 2, () => {
        throw new UnsupportedFeatureError('_sre.template()');
      }),
    ],
  ]);
});

function character(name: string, run: (code: number) => PyValue): PyValue {
  return builtin(name, 'one', 1, 1, ([value]) => run(Number(toIndex(value as PyValue))));
}

// CPython's `re/_constants.py`, whose PatternError is the one of this grader's `re`.

const CONSTANTS = String.raw`#
# Secret Labs' Regular Expression Engine
#
# various symbols used by the regular expression engine.
# run this script to update the _sre include files!
#
# Copyright (c) 1998-2001 by Secret Labs AB.  All rights reserved.
#
# See the __init__.py file for information on usage and redistribution.
#

"""Internal support module for sre"""

# update when constants are added or removed

MAGIC = 20230612

from _sre import MAXREPEAT, MAXGROUPS  # noqa: F401

# SRE standard exception (access as sre.error)
# should this really be here?

from re import PatternError


# Backward compatibility after renaming in 3.13
error = PatternError

class _NamedIntConstant(int):
    def __new__(cls, value, name):
        self = super(_NamedIntConstant, cls).__new__(cls, value)
        self.name = name
        return self

    def __repr__(self):
        return self.name

    __reduce__ = None

MAXREPEAT = _NamedIntConstant(MAXREPEAT, 'MAXREPEAT')

def _makecodes(*names):
    items = [_NamedIntConstant(i, name) for i, name in enumerate(names)]
    globals().update({item.name: item for item in items})
    return items

# operators
OPCODES = _makecodes(
    # failure=0 success=1 (just because it looks better that way :-)
    'FAILURE', 'SUCCESS',

    'ANY', 'ANY_ALL',
    'ASSERT', 'ASSERT_NOT',
    'AT',
    'BRANCH',
    'CATEGORY',
    'CHARSET', 'BIGCHARSET',
    'GROUPREF', 'GROUPREF_EXISTS',
    'IN',
    'INFO',
    'JUMP',
    'LITERAL',
    'MARK',
    'MAX_UNTIL',
    'MIN_UNTIL',
    'NOT_LITERAL',
    'NEGATE',
    'RANGE',
    'REPEAT',
    'REPEAT_ONE',
    'SUBPATTERN',
    'MIN_REPEAT_ONE',
    'ATOMIC_GROUP',
    'POSSESSIVE_REPEAT',
    'POSSESSIVE_REPEAT_ONE',

    'GROUPREF_IGNORE',
    'IN_IGNORE',
    'LITERAL_IGNORE',
    'NOT_LITERAL_IGNORE',

    'GROUPREF_LOC_IGNORE',
    'IN_LOC_IGNORE',
    'LITERAL_LOC_IGNORE',
    'NOT_LITERAL_LOC_IGNORE',

    'GROUPREF_UNI_IGNORE',
    'IN_UNI_IGNORE',
    'LITERAL_UNI_IGNORE',
    'NOT_LITERAL_UNI_IGNORE',
    'RANGE_UNI_IGNORE',

    # The following opcodes are only occurred in the parser output,
    # but not in the compiled code.
    'MIN_REPEAT', 'MAX_REPEAT',
)
del OPCODES[-2:] # remove MIN_REPEAT and MAX_REPEAT

# positions
ATCODES = _makecodes(
    'AT_BEGINNING', 'AT_BEGINNING_LINE', 'AT_BEGINNING_STRING',
    'AT_BOUNDARY', 'AT_NON_BOUNDARY',
    'AT_END', 'AT_END_LINE', 'AT_END_STRING',

    'AT_LOC_BOUNDARY', 'AT_LOC_NON_BOUNDARY',

    'AT_UNI_BOUNDARY', 'AT_UNI_NON_BOUNDARY',
)

# categories
CHCODES = _makecodes(
    'CATEGORY_DIGIT', 'CATEGORY_NOT_DIGIT',
    'CATEGORY_SPACE', 'CATEGORY_NOT_SPACE',
    'CATEGORY_WORD', 'CATEGORY_NOT_WORD',
    'CATEGORY_LINEBREAK', 'CATEGORY_NOT_LINEBREAK',

    'CATEGORY_LOC_WORD', 'CATEGORY_LOC_NOT_WORD',

    'CATEGORY_UNI_DIGIT', 'CATEGORY_UNI_NOT_DIGIT',
    'CATEGORY_UNI_SPACE', 'CATEGORY_UNI_NOT_SPACE',
    'CATEGORY_UNI_WORD', 'CATEGORY_UNI_NOT_WORD',
    'CATEGORY_UNI_LINEBREAK', 'CATEGORY_UNI_NOT_LINEBREAK',
)


# replacement operations for "ignore case" mode
OP_IGNORE = {
    LITERAL: LITERAL_IGNORE,
    NOT_LITERAL: NOT_LITERAL_IGNORE,
}

OP_LOCALE_IGNORE = {
    LITERAL: LITERAL_LOC_IGNORE,
    NOT_LITERAL: NOT_LITERAL_LOC_IGNORE,
}

OP_UNICODE_IGNORE = {
    LITERAL: LITERAL_UNI_IGNORE,
    NOT_LITERAL: NOT_LITERAL_UNI_IGNORE,
}

AT_MULTILINE = {
    AT_BEGINNING: AT_BEGINNING_LINE,
    AT_END: AT_END_LINE
}

AT_LOCALE = {
    AT_BOUNDARY: AT_LOC_BOUNDARY,
    AT_NON_BOUNDARY: AT_LOC_NON_BOUNDARY
}

AT_UNICODE = {
    AT_BOUNDARY: AT_UNI_BOUNDARY,
    AT_NON_BOUNDARY: AT_UNI_NON_BOUNDARY
}

CH_LOCALE = {
    CATEGORY_DIGIT: CATEGORY_DIGIT,
    CATEGORY_NOT_DIGIT: CATEGORY_NOT_DIGIT,
    CATEGORY_SPACE: CATEGORY_SPACE,
    CATEGORY_NOT_SPACE: CATEGORY_NOT_SPACE,
    CATEGORY_WORD: CATEGORY_LOC_WORD,
    CATEGORY_NOT_WORD: CATEGORY_LOC_NOT_WORD,
    CATEGORY_LINEBREAK: CATEGORY_LINEBREAK,
    CATEGORY_NOT_LINEBREAK: CATEGORY_NOT_LINEBREAK
}

CH_UNICODE = {
    CATEGORY_DIGIT: CATEGORY_UNI_DIGIT,
    CATEGORY_NOT_DIGIT: CATEGORY_UNI_NOT_DIGIT,
    CATEGORY_SPACE: CATEGORY_UNI_SPACE,
    CATEGORY_NOT_SPACE: CATEGORY_UNI_NOT_SPACE,
    CATEGORY_WORD: CATEGORY_UNI_WORD,
    CATEGORY_NOT_WORD: CATEGORY_UNI_NOT_WORD,
    CATEGORY_LINEBREAK: CATEGORY_UNI_LINEBREAK,
    CATEGORY_NOT_LINEBREAK: CATEGORY_UNI_NOT_LINEBREAK
}

CH_NEGATE = dict(zip(CHCODES[::2] + CHCODES[1::2], CHCODES[1::2] + CHCODES[::2]))

# flags
SRE_FLAG_IGNORECASE = 2 # case insensitive
SRE_FLAG_LOCALE = 4 # honour system locale
SRE_FLAG_MULTILINE = 8 # treat target as multiline string
SRE_FLAG_DOTALL = 16 # treat target as a single string
SRE_FLAG_UNICODE = 32 # use unicode "locale"
SRE_FLAG_VERBOSE = 64 # ignore whitespace and comments
SRE_FLAG_DEBUG = 128 # debugging
SRE_FLAG_ASCII = 256 # use ascii "locale"

# flags for INFO primitive
SRE_INFO_PREFIX = 1 # has prefix
SRE_INFO_LITERAL = 2 # entire pattern is literal (given by prefix)
SRE_INFO_CHARSET = 4 # pattern starts with character from given set
`;

// CPython's `re/_parser.py`, `re/_casefix.py`, and `re/_compiler.py`.

const PARSER = String.raw`#
# Secret Labs' Regular Expression Engine
#
# convert re-style regular expression to sre pattern
#
# Copyright (c) 1998-2001 by Secret Labs AB.  All rights reserved.
#
# See the __init__.py file for information on usage and redistribution.
#

"""Internal support module for sre"""

# XXX: show string offset and offending character for all errors

from re._constants import *

SPECIAL_CHARS = ".\\[{()*+?^$|"
REPEAT_CHARS = "*+?{"

DIGITS = frozenset("0123456789")

OCTDIGITS = frozenset("01234567")
HEXDIGITS = frozenset("0123456789abcdefABCDEF")
ASCIILETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

WHITESPACE = frozenset(" \t\n\r\v\f")

_REPEATCODES = frozenset({MIN_REPEAT, MAX_REPEAT, POSSESSIVE_REPEAT})
_UNITCODES = frozenset({ANY, RANGE, IN, LITERAL, NOT_LITERAL, CATEGORY})

ESCAPES = {
    r"\a": (LITERAL, ord("\a")),
    r"\b": (LITERAL, ord("\b")),
    r"\f": (LITERAL, ord("\f")),
    r"\n": (LITERAL, ord("\n")),
    r"\r": (LITERAL, ord("\r")),
    r"\t": (LITERAL, ord("\t")),
    r"\v": (LITERAL, ord("\v")),
    r"\\": (LITERAL, ord("\\"))
}

CATEGORIES = {
    r"\A": (AT, AT_BEGINNING_STRING), # start of string
    r"\b": (AT, AT_BOUNDARY),
    r"\B": (AT, AT_NON_BOUNDARY),
    r"\d": (IN, [(CATEGORY, CATEGORY_DIGIT)]),
    r"\D": (IN, [(CATEGORY, CATEGORY_NOT_DIGIT)]),
    r"\s": (IN, [(CATEGORY, CATEGORY_SPACE)]),
    r"\S": (IN, [(CATEGORY, CATEGORY_NOT_SPACE)]),
    r"\w": (IN, [(CATEGORY, CATEGORY_WORD)]),
    r"\W": (IN, [(CATEGORY, CATEGORY_NOT_WORD)]),
    r"\z": (AT, AT_END_STRING), # end of string
    r"\Z": (AT, AT_END_STRING), # end of string (obsolete)
}

FLAGS = {
    # standard flags
    "i": SRE_FLAG_IGNORECASE,
    "L": SRE_FLAG_LOCALE,
    "m": SRE_FLAG_MULTILINE,
    "s": SRE_FLAG_DOTALL,
    "x": SRE_FLAG_VERBOSE,
    # extensions
    "a": SRE_FLAG_ASCII,
    "u": SRE_FLAG_UNICODE,
}

TYPE_FLAGS = SRE_FLAG_ASCII | SRE_FLAG_LOCALE | SRE_FLAG_UNICODE
GLOBAL_FLAGS = SRE_FLAG_DEBUG

# Maximal value returned by SubPattern.getwidth().
# Must be larger than MAXREPEAT, MAXCODE and sys.maxsize.
MAXWIDTH = 1 << 64

class State:
    # keeps track of state for parsing
    def __init__(self):
        self.flags = 0
        self.groupdict = {}
        self.groupwidths = [None]  # group 0
        self.lookbehindgroups = None
        self.grouprefpos = {}
    @property
    def groups(self):
        return len(self.groupwidths)
    def opengroup(self, name=None):
        gid = self.groups
        self.groupwidths.append(None)
        if self.groups > MAXGROUPS:
            raise error("too many groups")
        if name is not None:
            ogid = self.groupdict.get(name, None)
            if ogid is not None:
                raise error("redefinition of group name %r as group %d; "
                            "was group %d" % (name, gid,  ogid))
            self.groupdict[name] = gid
        return gid
    def closegroup(self, gid, p):
        self.groupwidths[gid] = p.getwidth()
    def checkgroup(self, gid):
        return gid < self.groups and self.groupwidths[gid] is not None

    def checklookbehindgroup(self, gid, source):
        if self.lookbehindgroups is not None:
            if not self.checkgroup(gid):
                raise source.error('cannot refer to an open group')
            if gid >= self.lookbehindgroups:
                raise source.error('cannot refer to group defined in the same '
                                   'lookbehind subpattern')

class SubPattern:
    # a subpattern, in intermediate form
    def __init__(self, state, data=None):
        self.state = state
        if data is None:
            data = []
        self.data = data
        self.width = None

    def dump(self, level=0):
        seqtypes = (tuple, list)
        for op, av in self.data:
            print(level*"  " + str(op), end='')
            if op is IN:
                # member sublanguage
                print()
                for op, a in av:
                    print((level+1)*"  " + str(op), a)
            elif op is BRANCH:
                print()
                for i, a in enumerate(av[1]):
                    if i:
                        print(level*"  " + "OR")
                    a.dump(level+1)
            elif op is GROUPREF_EXISTS:
                condgroup, item_yes, item_no = av
                print('', condgroup)
                item_yes.dump(level+1)
                if item_no:
                    print(level*"  " + "ELSE")
                    item_no.dump(level+1)
            elif isinstance(av, SubPattern):
                print()
                av.dump(level+1)
            elif isinstance(av, seqtypes):
                nl = False
                for a in av:
                    if isinstance(a, SubPattern):
                        if not nl:
                            print()
                        a.dump(level+1)
                        nl = True
                    else:
                        if not nl:
                            print(' ', end='')
                        print(a, end='')
                        nl = False
                if not nl:
                    print()
            else:
                print('', av)
    def __repr__(self):
        return repr(self.data)
    def __len__(self):
        return len(self.data)
    def __delitem__(self, index):
        del self.data[index]
    def __getitem__(self, index):
        if isinstance(index, slice):
            return SubPattern(self.state, self.data[index])
        return self.data[index]
    def __setitem__(self, index, code):
        self.data[index] = code
    def insert(self, index, code):
        self.data.insert(index, code)
    def append(self, code):
        self.data.append(code)
    def getwidth(self):
        # determine the width (min, max) for this subpattern
        if self.width is not None:
            return self.width
        lo = hi = 0
        for op, av in self.data:
            if op is BRANCH:
                i = MAXWIDTH
                j = 0
                for av in av[1]:
                    l, h = av.getwidth()
                    i = min(i, l)
                    j = max(j, h)
                lo = lo + i
                hi = hi + j
            elif op is ATOMIC_GROUP:
                i, j = av.getwidth()
                lo = lo + i
                hi = hi + j
            elif op is SUBPATTERN:
                i, j = av[-1].getwidth()
                lo = lo + i
                hi = hi + j
            elif op in _REPEATCODES:
                i, j = av[2].getwidth()
                lo = lo + i * av[0]
                if av[1] == MAXREPEAT and j:
                    hi = MAXWIDTH
                else:
                    hi = hi + j * av[1]
            elif op in _UNITCODES:
                lo = lo + 1
                hi = hi + 1
            elif op is GROUPREF:
                i, j = self.state.groupwidths[av]
                lo = lo + i
                hi = hi + j
            elif op is GROUPREF_EXISTS:
                i, j = av[1].getwidth()
                if av[2] is not None:
                    l, h = av[2].getwidth()
                    i = min(i, l)
                    j = max(j, h)
                else:
                    i = 0
                lo = lo + i
                hi = hi + j
            elif op is SUCCESS:
                break
        self.width = min(lo, MAXWIDTH), min(hi, MAXWIDTH)
        return self.width

class Tokenizer:
    def __init__(self, string):
        self.istext = isinstance(string, str)
        self.string = string
        if not self.istext:
            string = str(string, 'latin1')
        self.decoded_string = string
        self.index = 0
        self.next = None
        self.__next()
    def __next(self):
        index = self.index
        try:
            char = self.decoded_string[index]
        except IndexError:
            self.next = None
            return
        if char == "\\":
            index += 1
            try:
                char += self.decoded_string[index]
            except IndexError:
                raise error("bad escape (end of pattern)",
                            self.string, len(self.string) - 1) from None
        self.index = index + 1
        self.next = char
    def match(self, char):
        if char == self.next:
            self.__next()
            return True
        return False
    def get(self):
        this = self.next
        self.__next()
        return this
    def getwhile(self, n, charset):
        result = ''
        for _ in range(n):
            c = self.next
            if c not in charset:
                break
            result += c
            self.__next()
        return result
    def getuntil(self, terminator, name):
        result = ''
        while True:
            c = self.next
            self.__next()
            if c is None:
                if not result:
                    raise self.error("missing " + name)
                raise self.error("missing %s, unterminated name" % terminator,
                                 len(result))
            if c == terminator:
                if not result:
                    raise self.error("missing " + name, 1)
                break
            result += c
        return result
    @property
    def pos(self):
        return self.index - len(self.next or '')
    def tell(self):
        return self.index - len(self.next or '')
    def seek(self, index):
        self.index = index
        self.__next()

    def error(self, msg, offset=0):
        if not self.istext:
            msg = msg.encode('ascii', 'backslashreplace').decode('ascii')
        return error(msg, self.string, self.tell() - offset)

    def checkgroupname(self, name, offset):
        if not (self.istext or name.isascii()):
            msg = "bad character in group name %a" % name
            raise self.error(msg, len(name) + offset)
        if not name.isidentifier():
            msg = "bad character in group name %r" % name
            raise self.error(msg, len(name) + offset)

def _class_escape(source, escape):
    # handle escape code inside character class
    code = ESCAPES.get(escape)
    if code:
        return code
    code = CATEGORIES.get(escape)
    if code and code[0] is IN:
        return code
    try:
        c = escape[1:2]
        if c == "x":
            # hexadecimal escape (exactly two digits)
            escape += source.getwhile(2, HEXDIGITS)
            if len(escape) != 4:
                raise source.error("incomplete escape %s" % escape, len(escape))
            return LITERAL, int(escape[2:], 16)
        elif c == "u" and source.istext:
            # unicode escape (exactly four digits)
            escape += source.getwhile(4, HEXDIGITS)
            if len(escape) != 6:
                raise source.error("incomplete escape %s" % escape, len(escape))
            return LITERAL, int(escape[2:], 16)
        elif c == "U" and source.istext:
            # unicode escape (exactly eight digits)
            escape += source.getwhile(8, HEXDIGITS)
            if len(escape) != 10:
                raise source.error("incomplete escape %s" % escape, len(escape))
            c = int(escape[2:], 16)
            chr(c) # raise ValueError for invalid code
            return LITERAL, c
        elif c == "N" and source.istext:
            import unicodedata
            # named unicode escape e.g. \N{EM DASH}
            if not source.match('{'):
                raise source.error("missing {")
            charname = source.getuntil('}', 'character name')
            try:
                c = ord(unicodedata.lookup(charname))
            except (KeyError, TypeError):
                raise source.error("undefined character name %r" % charname,
                                   len(charname) + len(r'\N{}')) from None
            return LITERAL, c
        elif c in OCTDIGITS:
            # octal escape (up to three digits)
            escape += source.getwhile(2, OCTDIGITS)
            c = int(escape[1:], 8)
            if c > 0o377:
                raise source.error('octal escape value %s outside of '
                                   'range 0-0o377' % escape, len(escape))
            return LITERAL, c
        elif c in DIGITS:
            raise ValueError
        if len(escape) == 2:
            if c in ASCIILETTERS:
                raise source.error('bad escape %s' % escape, len(escape))
            return LITERAL, ord(escape[1])
    except ValueError:
        pass
    raise source.error("bad escape %s" % escape, len(escape))

def _escape(source, escape, state):
    # handle escape code in expression
    code = CATEGORIES.get(escape)
    if code:
        return code
    code = ESCAPES.get(escape)
    if code:
        return code
    try:
        c = escape[1:2]
        if c == "x":
            # hexadecimal escape
            escape += source.getwhile(2, HEXDIGITS)
            if len(escape) != 4:
                raise source.error("incomplete escape %s" % escape, len(escape))
            return LITERAL, int(escape[2:], 16)
        elif c == "u" and source.istext:
            # unicode escape (exactly four digits)
            escape += source.getwhile(4, HEXDIGITS)
            if len(escape) != 6:
                raise source.error("incomplete escape %s" % escape, len(escape))
            return LITERAL, int(escape[2:], 16)
        elif c == "U" and source.istext:
            # unicode escape (exactly eight digits)
            escape += source.getwhile(8, HEXDIGITS)
            if len(escape) != 10:
                raise source.error("incomplete escape %s" % escape, len(escape))
            c = int(escape[2:], 16)
            chr(c) # raise ValueError for invalid code
            return LITERAL, c
        elif c == "N" and source.istext:
            import unicodedata
            # named unicode escape e.g. \N{EM DASH}
            if not source.match('{'):
                raise source.error("missing {")
            charname = source.getuntil('}', 'character name')
            try:
                c = ord(unicodedata.lookup(charname))
            except (KeyError, TypeError):
                raise source.error("undefined character name %r" % charname,
                                   len(charname) + len(r'\N{}')) from None
            return LITERAL, c
        elif c == "0":
            # octal escape
            escape += source.getwhile(2, OCTDIGITS)
            return LITERAL, int(escape[1:], 8)
        elif c in DIGITS:
            # octal escape *or* decimal group reference (sigh)
            if source.next in DIGITS:
                escape += source.get()
                if (escape[1] in OCTDIGITS and escape[2] in OCTDIGITS and
                    source.next in OCTDIGITS):
                    # got three octal digits; this is an octal escape
                    escape += source.get()
                    c = int(escape[1:], 8)
                    if c > 0o377:
                        raise source.error('octal escape value %s outside of '
                                           'range 0-0o377' % escape,
                                           len(escape))
                    return LITERAL, c
            # not an octal escape, so this is a group reference
            group = int(escape[1:])
            if group < state.groups:
                if not state.checkgroup(group):
                    raise source.error("cannot refer to an open group",
                                       len(escape))
                state.checklookbehindgroup(group, source)
                return GROUPREF, group
            raise source.error("invalid group reference %d" % group, len(escape) - 1)
        if len(escape) == 2:
            if c in ASCIILETTERS:
                raise source.error("bad escape %s" % escape, len(escape))
            return LITERAL, ord(escape[1])
    except ValueError:
        pass
    raise source.error("bad escape %s" % escape, len(escape))

def _uniq(items):
    return list(dict.fromkeys(items))

def _parse_sub(source, state, verbose, nested):
    # parse an alternation: a|b|c

    items = []
    itemsappend = items.append
    sourcematch = source.match
    start = source.tell()
    while True:
        itemsappend(_parse(source, state, verbose, nested + 1,
                           not nested and not items))
        if not sourcematch("|"):
            break
        if not nested:
            verbose = state.flags & SRE_FLAG_VERBOSE

    if len(items) == 1:
        return items[0]

    subpattern = SubPattern(state)

    # check if all items share a common prefix
    while True:
        prefix = None
        for item in items:
            if not item:
                break
            if prefix is None:
                prefix = item[0]
            elif item[0] != prefix:
                break
        else:
            # all subitems start with a common "prefix".
            # move it out of the branch
            for item in items:
                del item[0]
            subpattern.append(prefix)
            continue # check next one
        break

    # check if the branch can be replaced by a character set
    set = []
    for item in items:
        if len(item) != 1:
            break
        op, av = item[0]
        if op is LITERAL:
            set.append((op, av))
        elif op is IN and av[0][0] is not NEGATE:
            set.extend(av)
        else:
            break
    else:
        # we can store this as a character set instead of a
        # branch (the compiler may optimize this even more)
        subpattern.append((IN, _uniq(set)))
        return subpattern

    subpattern.append((BRANCH, (None, items)))
    return subpattern

def _parse(source, state, verbose, nested, first=False):
    # parse a simple pattern
    subpattern = SubPattern(state)

    # precompute constants into local variables
    subpatternappend = subpattern.append
    sourceget = source.get
    sourcematch = source.match
    _len = len
    _ord = ord

    while True:

        this = source.next
        if this is None:
            break # end of pattern
        if this in "|)":
            break # end of subpattern
        sourceget()

        if verbose:
            # skip whitespace and comments
            if this in WHITESPACE:
                continue
            if this == "#":
                while True:
                    this = sourceget()
                    if this is None or this == "\n":
                        break
                continue

        if this[0] == "\\":
            code = _escape(source, this, state)
            subpatternappend(code)

        elif this not in SPECIAL_CHARS:
            subpatternappend((LITERAL, _ord(this)))

        elif this == "[":
            here = source.tell() - 1
            # character set
            set = []
            setappend = set.append
##          if sourcematch(":"):
##              pass # handle character classes
            if source.next == '[':
                import warnings
                warnings.warn(
                    'Possible nested set at position %d' % source.tell(),
                    FutureWarning, stacklevel=nested + 6
                )
            negate = sourcematch("^")
            # check remaining characters
            while True:
                this = sourceget()
                if this is None:
                    raise source.error("unterminated character set",
                                       source.tell() - here)
                if this == "]" and set:
                    break
                elif this[0] == "\\":
                    code1 = _class_escape(source, this)
                else:
                    if set and this in '-&~|' and source.next == this:
                        import warnings
                        warnings.warn(
                            'Possible set %s at position %d' % (
                                'difference' if this == '-' else
                                'intersection' if this == '&' else
                                'symmetric difference' if this == '~' else
                                'union',
                                source.tell() - 1),
                            FutureWarning, stacklevel=nested + 6
                        )
                    code1 = LITERAL, _ord(this)
                if sourcematch("-"):
                    # potential range
                    that = sourceget()
                    if that is None:
                        raise source.error("unterminated character set",
                                           source.tell() - here)
                    if that == "]":
                        if code1[0] is IN:
                            code1 = code1[1][0]
                        setappend(code1)
                        setappend((LITERAL, _ord("-")))
                        break
                    if that[0] == "\\":
                        code2 = _class_escape(source, that)
                    else:
                        if that == '-':
                            import warnings
                            warnings.warn(
                                'Possible set difference at position %d' % (
                                    source.tell() - 2),
                                FutureWarning, stacklevel=nested + 6
                            )
                        code2 = LITERAL, _ord(that)
                    if code1[0] != LITERAL or code2[0] != LITERAL:
                        msg = "bad character range %s-%s" % (this, that)
                        raise source.error(msg, len(this) + 1 + len(that))
                    lo = code1[1]
                    hi = code2[1]
                    if hi < lo:
                        msg = "bad character range %s-%s" % (this, that)
                        raise source.error(msg, len(this) + 1 + len(that))
                    setappend((RANGE, (lo, hi)))
                else:
                    if code1[0] is IN:
                        code1 = code1[1][0]
                    setappend(code1)

            set = _uniq(set)
            # XXX: <fl> should move set optimization to compiler!
            if _len(set) == 1 and set[0][0] is LITERAL:
                # optimization
                if negate:
                    subpatternappend((NOT_LITERAL, set[0][1]))
                else:
                    subpatternappend(set[0])
            else:
                if negate:
                    set.insert(0, (NEGATE, None))
                # charmap optimization can't be added here because
                # global flags still are not known
                subpatternappend((IN, set))

        elif this in REPEAT_CHARS:
            # repeat previous item
            here = source.tell()
            if this == "?":
                min, max = 0, 1
            elif this == "*":
                min, max = 0, MAXREPEAT

            elif this == "+":
                min, max = 1, MAXREPEAT
            elif this == "{":
                if source.next == "}":
                    subpatternappend((LITERAL, _ord(this)))
                    continue

                min, max = 0, MAXREPEAT
                lo = hi = ""
                while source.next in DIGITS:
                    lo += sourceget()
                if sourcematch(","):
                    while source.next in DIGITS:
                        hi += sourceget()
                else:
                    hi = lo
                if not sourcematch("}"):
                    subpatternappend((LITERAL, _ord(this)))
                    source.seek(here)
                    continue

                if lo:
                    min = int(lo)
                    if min >= MAXREPEAT:
                        raise OverflowError("the repetition number is too large")
                if hi:
                    max = int(hi)
                    if max >= MAXREPEAT:
                        raise OverflowError("the repetition number is too large")
                    if max < min:
                        raise source.error("min repeat greater than max repeat",
                                           source.tell() - here)
            else:
                raise AssertionError("unsupported quantifier %r" % (char,))
            # figure out which item to repeat
            if subpattern:
                item = subpattern[-1:]
            else:
                item = None
            if not item or item[0][0] is AT:
                raise source.error("nothing to repeat",
                                   source.tell() - here + len(this))
            if item[0][0] in _REPEATCODES:
                raise source.error("multiple repeat",
                                   source.tell() - here + len(this))
            if item[0][0] is SUBPATTERN:
                group, add_flags, del_flags, p = item[0][1]
                if group is None and not add_flags and not del_flags:
                    item = p
            if sourcematch("?"):
                # Non-Greedy Match
                subpattern[-1] = (MIN_REPEAT, (min, max, item))
            elif sourcematch("+"):
                # Possessive Match (Always Greedy)
                subpattern[-1] = (POSSESSIVE_REPEAT, (min, max, item))
            else:
                # Greedy Match
                subpattern[-1] = (MAX_REPEAT, (min, max, item))

        elif this == ".":
            subpatternappend((ANY, None))

        elif this == "(":
            start = source.tell() - 1
            capture = True
            atomic = False
            name = None
            add_flags = 0
            del_flags = 0
            if sourcematch("?"):
                # options
                char = sourceget()
                if char is None:
                    raise source.error("unexpected end of pattern")
                if char == "P":
                    # python extensions
                    if sourcematch("<"):
                        # named group: skip forward to end of name
                        name = source.getuntil(">", "group name")
                        source.checkgroupname(name, 1)
                    elif sourcematch("="):
                        # named backreference
                        name = source.getuntil(")", "group name")
                        source.checkgroupname(name, 1)
                        gid = state.groupdict.get(name)
                        if gid is None:
                            msg = "unknown group name %r" % name
                            raise source.error(msg, len(name) + 1)
                        if not state.checkgroup(gid):
                            raise source.error("cannot refer to an open group",
                                               len(name) + 1)
                        state.checklookbehindgroup(gid, source)
                        subpatternappend((GROUPREF, gid))
                        continue

                    else:
                        char = sourceget()
                        if char is None:
                            raise source.error("unexpected end of pattern")
                        raise source.error("unknown extension ?P" + char,
                                           len(char) + 2)
                elif char == ":":
                    # non-capturing group
                    capture = False
                elif char == "#":
                    # comment
                    while True:
                        if source.next is None:
                            raise source.error("missing ), unterminated comment",
                                               source.tell() - start)
                        if sourceget() == ")":
                            break
                    continue

                elif char in "=!<":
                    # lookahead assertions
                    dir = 1
                    if char == "<":
                        char = sourceget()
                        if char is None:
                            raise source.error("unexpected end of pattern")
                        if char not in "=!":
                            raise source.error("unknown extension ?<" + char,
                                               len(char) + 2)
                        dir = -1 # lookbehind
                        lookbehindgroups = state.lookbehindgroups
                        if lookbehindgroups is None:
                            state.lookbehindgroups = state.groups
                    p = _parse_sub(source, state, verbose, nested + 1)
                    if dir < 0:
                        if lookbehindgroups is None:
                            state.lookbehindgroups = None
                    if not sourcematch(")"):
                        raise source.error("missing ), unterminated subpattern",
                                           source.tell() - start)
                    if char == "=":
                        subpatternappend((ASSERT, (dir, p)))
                    elif p:
                        subpatternappend((ASSERT_NOT, (dir, p)))
                    else:
                        subpatternappend((FAILURE, ()))
                    continue

                elif char == "(":
                    # conditional backreference group
                    condname = source.getuntil(")", "group name")
                    if not (condname.isdecimal() and condname.isascii()):
                        source.checkgroupname(condname, 1)
                        condgroup = state.groupdict.get(condname)
                        if condgroup is None:
                            msg = "unknown group name %r" % condname
                            raise source.error(msg, len(condname) + 1)
                    else:
                        condgroup = int(condname)
                        if not condgroup:
                            raise source.error("bad group number",
                                               len(condname) + 1)
                        if condgroup >= MAXGROUPS:
                            msg = "invalid group reference %d" % condgroup
                            raise source.error(msg, len(condname) + 1)
                        if condgroup not in state.grouprefpos:
                            state.grouprefpos[condgroup] = (
                                source.tell() - len(condname) - 1
                            )
                    state.checklookbehindgroup(condgroup, source)
                    item_yes = _parse(source, state, verbose, nested + 1)
                    if source.match("|"):
                        item_no = _parse(source, state, verbose, nested + 1)
                        if source.next == "|":
                            raise source.error("conditional backref with more than two branches")
                    else:
                        item_no = None
                    if not source.match(")"):
                        raise source.error("missing ), unterminated subpattern",
                                           source.tell() - start)
                    subpatternappend((GROUPREF_EXISTS, (condgroup, item_yes, item_no)))
                    continue

                elif char == ">":
                    # non-capturing, atomic group
                    capture = False
                    atomic = True
                elif char in FLAGS or char == "-":
                    # flags
                    flags = _parse_flags(source, state, char)
                    if flags is None:  # global flags
                        if not first or subpattern:
                            raise source.error('global flags not at the start '
                                               'of the expression',
                                               source.tell() - start)
                        verbose = state.flags & SRE_FLAG_VERBOSE
                        continue

                    add_flags, del_flags = flags
                    capture = False
                else:
                    raise source.error("unknown extension ?" + char,
                                       len(char) + 1)

            # parse group contents
            if capture:
                try:
                    group = state.opengroup(name)
                except error as err:
                    raise source.error(err.msg, len(name) + 1) from None
            else:
                group = None
            sub_verbose = ((verbose or (add_flags & SRE_FLAG_VERBOSE)) and
                           not (del_flags & SRE_FLAG_VERBOSE))
            p = _parse_sub(source, state, sub_verbose, nested + 1)
            if not source.match(")"):
                raise source.error("missing ), unterminated subpattern",
                                   source.tell() - start)
            if group is not None:
                state.closegroup(group, p)
            if atomic:
                assert group is None
                subpatternappend((ATOMIC_GROUP, p))
            else:
                subpatternappend((SUBPATTERN, (group, add_flags, del_flags, p)))

        elif this == "^":
            subpatternappend((AT, AT_BEGINNING))

        elif this == "$":
            subpatternappend((AT, AT_END))

        else:
            raise AssertionError("unsupported special character %r" % (char,))

    # unpack non-capturing groups
    for i in range(len(subpattern))[::-1]:
        op, av = subpattern[i]
        if op is SUBPATTERN:
            group, add_flags, del_flags, p = av
            if group is None and not add_flags and not del_flags:
                subpattern[i: i+1] = p

    return subpattern

def _parse_flags(source, state, char):
    sourceget = source.get
    add_flags = 0
    del_flags = 0
    if char != "-":
        while True:
            flag = FLAGS[char]
            if source.istext:
                if char == 'L':
                    msg = "bad inline flags: cannot use 'L' flag with a str pattern"
                    raise source.error(msg)
            else:
                if char == 'u':
                    msg = "bad inline flags: cannot use 'u' flag with a bytes pattern"
                    raise source.error(msg)
            add_flags |= flag
            if (flag & TYPE_FLAGS) and (add_flags & TYPE_FLAGS) != flag:
                msg = "bad inline flags: flags 'a', 'u' and 'L' are incompatible"
                raise source.error(msg)
            char = sourceget()
            if char is None:
                raise source.error("missing -, : or )")
            if char in ")-:":
                break
            if char not in FLAGS:
                msg = "unknown flag" if char.isalpha() else "missing -, : or )"
                raise source.error(msg, len(char))
    if char == ")":
        state.flags |= add_flags
        return None
    if add_flags & GLOBAL_FLAGS:
        raise source.error("bad inline flags: cannot turn on global flag", 1)
    if char == "-":
        char = sourceget()
        if char is None:
            raise source.error("missing flag")
        if char not in FLAGS:
            msg = "unknown flag" if char.isalpha() else "missing flag"
            raise source.error(msg, len(char))
        while True:
            flag = FLAGS[char]
            if flag & TYPE_FLAGS:
                msg = "bad inline flags: cannot turn off flags 'a', 'u' and 'L'"
                raise source.error(msg)
            del_flags |= flag
            char = sourceget()
            if char is None:
                raise source.error("missing :")
            if char == ":":
                break
            if char not in FLAGS:
                msg = "unknown flag" if char.isalpha() else "missing :"
                raise source.error(msg, len(char))
    assert char == ":"
    if del_flags & GLOBAL_FLAGS:
        raise source.error("bad inline flags: cannot turn off global flag", 1)
    if add_flags & del_flags:
        raise source.error("bad inline flags: flag turned on and off", 1)
    return add_flags, del_flags

def fix_flags(src, flags):
    # Check and fix flags according to the type of pattern (str or bytes)
    if isinstance(src, str):
        if flags & SRE_FLAG_LOCALE:
            raise ValueError("cannot use LOCALE flag with a str pattern")
        if not flags & SRE_FLAG_ASCII:
            flags |= SRE_FLAG_UNICODE
        elif flags & SRE_FLAG_UNICODE:
            raise ValueError("ASCII and UNICODE flags are incompatible")
    else:
        if flags & SRE_FLAG_UNICODE:
            raise ValueError("cannot use UNICODE flag with a bytes pattern")
        if flags & SRE_FLAG_LOCALE and flags & SRE_FLAG_ASCII:
            raise ValueError("ASCII and LOCALE flags are incompatible")
    return flags

def parse(str, flags=0, state=None):
    # parse 're' pattern into list of (opcode, argument) tuples

    source = Tokenizer(str)

    if state is None:
        state = State()
    state.flags = flags
    state.str = str

    p = _parse_sub(source, state, flags & SRE_FLAG_VERBOSE, 0)
    p.state.flags = fix_flags(str, p.state.flags)

    if source.next is not None:
        assert source.next == ")"
        raise source.error("unbalanced parenthesis")

    for g in p.state.grouprefpos:
        if g >= p.state.groups:
            msg = "invalid group reference %d" % g
            raise error(msg, str, p.state.grouprefpos[g])

    if flags & SRE_FLAG_DEBUG:
        p.dump()

    return p

def parse_template(source, pattern):
    # parse 're' replacement string into list of literals and
    # group references
    s = Tokenizer(source)
    sget = s.get
    result = []
    literal = []
    lappend = literal.append
    def addliteral():
        if s.istext:
            result.append(''.join(literal))
        else:
            # The tokenizer implicitly decodes bytes objects as latin-1, we must
            # therefore re-encode the final representation.
            result.append(''.join(literal).encode('latin-1'))
        del literal[:]
    def addgroup(index, pos):
        if index > pattern.groups:
            raise s.error("invalid group reference %d" % index, pos)
        addliteral()
        result.append(index)
    groupindex = pattern.groupindex
    while True:
        this = sget()
        if this is None:
            break # end of replacement string
        if this[0] == "\\":
            # group
            c = this[1]
            if c == "g":
                if not s.match("<"):
                    raise s.error("missing <")
                name = s.getuntil(">", "group name")
                if not (name.isdecimal() and name.isascii()):
                    s.checkgroupname(name, 1)
                    try:
                        index = groupindex[name]
                    except KeyError:
                        raise IndexError("unknown group name %r" % name) from None
                else:
                    index = int(name)
                    if index >= MAXGROUPS:
                        raise s.error("invalid group reference %d" % index,
                                      len(name) + 1)
                addgroup(index, len(name) + 1)
            elif c == "0":
                if s.next in OCTDIGITS:
                    this += sget()
                    if s.next in OCTDIGITS:
                        this += sget()
                lappend(chr(int(this[1:], 8) & 0xff))
            elif c in DIGITS:
                isoctal = False
                if s.next in DIGITS:
                    this += sget()
                    if (c in OCTDIGITS and this[2] in OCTDIGITS and
                        s.next in OCTDIGITS):
                        this += sget()
                        isoctal = True
                        c = int(this[1:], 8)
                        if c > 0o377:
                            raise s.error('octal escape value %s outside of '
                                          'range 0-0o377' % this, len(this))
                        lappend(chr(c))
                if not isoctal:
                    addgroup(int(this[1:]), len(this) - 1)
            else:
                try:
                    this = chr(ESCAPES[this][1])
                except KeyError:
                    if c in ASCIILETTERS:
                        raise s.error('bad escape %s' % this, len(this)) from None
                lappend(this)
        else:
            lappend(this)
    addliteral()
    return result
`;

const CASEFIX = String.raw`# Auto-generated by Tools/build/generate_re_casefix.py.

# Maps the code of lowercased character to codes of different lowercased
# characters which have the same uppercase.
_EXTRA_CASES = {
    # LATIN SMALL LETTER I: LATIN SMALL LETTER DOTLESS I
    0x0069: (0x0131,), # 'i': 'ı'
    # LATIN SMALL LETTER S: LATIN SMALL LETTER LONG S
    0x0073: (0x017f,), # 's': 'ſ'
    # MICRO SIGN: GREEK SMALL LETTER MU
    0x00b5: (0x03bc,), # 'µ': 'μ'
    # LATIN SMALL LETTER DOTLESS I: LATIN SMALL LETTER I
    0x0131: (0x0069,), # 'ı': 'i'
    # LATIN SMALL LETTER LONG S: LATIN SMALL LETTER S
    0x017f: (0x0073,), # 'ſ': 's'
    # COMBINING GREEK YPOGEGRAMMENI: GREEK SMALL LETTER IOTA, GREEK PROSGEGRAMMENI
    0x0345: (0x03b9, 0x1fbe), # '\u0345': 'ιι'
    # GREEK SMALL LETTER IOTA WITH DIALYTIKA AND TONOS: GREEK SMALL LETTER IOTA WITH DIALYTIKA AND OXIA
    0x0390: (0x1fd3,), # 'ΐ': 'ΐ'
    # GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND TONOS: GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND OXIA
    0x03b0: (0x1fe3,), # 'ΰ': 'ΰ'
    # GREEK SMALL LETTER BETA: GREEK BETA SYMBOL
    0x03b2: (0x03d0,), # 'β': 'ϐ'
    # GREEK SMALL LETTER EPSILON: GREEK LUNATE EPSILON SYMBOL
    0x03b5: (0x03f5,), # 'ε': 'ϵ'
    # GREEK SMALL LETTER THETA: GREEK THETA SYMBOL
    0x03b8: (0x03d1,), # 'θ': 'ϑ'
    # GREEK SMALL LETTER IOTA: COMBINING GREEK YPOGEGRAMMENI, GREEK PROSGEGRAMMENI
    0x03b9: (0x0345, 0x1fbe), # 'ι': '\u0345ι'
    # GREEK SMALL LETTER KAPPA: GREEK KAPPA SYMBOL
    0x03ba: (0x03f0,), # 'κ': 'ϰ'
    # GREEK SMALL LETTER MU: MICRO SIGN
    0x03bc: (0x00b5,), # 'μ': 'µ'
    # GREEK SMALL LETTER PI: GREEK PI SYMBOL
    0x03c0: (0x03d6,), # 'π': 'ϖ'
    # GREEK SMALL LETTER RHO: GREEK RHO SYMBOL
    0x03c1: (0x03f1,), # 'ρ': 'ϱ'
    # GREEK SMALL LETTER FINAL SIGMA: GREEK SMALL LETTER SIGMA
    0x03c2: (0x03c3,), # 'ς': 'σ'
    # GREEK SMALL LETTER SIGMA: GREEK SMALL LETTER FINAL SIGMA
    0x03c3: (0x03c2,), # 'σ': 'ς'
    # GREEK SMALL LETTER PHI: GREEK PHI SYMBOL
    0x03c6: (0x03d5,), # 'φ': 'ϕ'
    # GREEK BETA SYMBOL: GREEK SMALL LETTER BETA
    0x03d0: (0x03b2,), # 'ϐ': 'β'
    # GREEK THETA SYMBOL: GREEK SMALL LETTER THETA
    0x03d1: (0x03b8,), # 'ϑ': 'θ'
    # GREEK PHI SYMBOL: GREEK SMALL LETTER PHI
    0x03d5: (0x03c6,), # 'ϕ': 'φ'
    # GREEK PI SYMBOL: GREEK SMALL LETTER PI
    0x03d6: (0x03c0,), # 'ϖ': 'π'
    # GREEK KAPPA SYMBOL: GREEK SMALL LETTER KAPPA
    0x03f0: (0x03ba,), # 'ϰ': 'κ'
    # GREEK RHO SYMBOL: GREEK SMALL LETTER RHO
    0x03f1: (0x03c1,), # 'ϱ': 'ρ'
    # GREEK LUNATE EPSILON SYMBOL: GREEK SMALL LETTER EPSILON
    0x03f5: (0x03b5,), # 'ϵ': 'ε'
    # CYRILLIC SMALL LETTER VE: CYRILLIC SMALL LETTER ROUNDED VE
    0x0432: (0x1c80,), # 'в': 'ᲀ'
    # CYRILLIC SMALL LETTER DE: CYRILLIC SMALL LETTER LONG-LEGGED DE
    0x0434: (0x1c81,), # 'д': 'ᲁ'
    # CYRILLIC SMALL LETTER O: CYRILLIC SMALL LETTER NARROW O
    0x043e: (0x1c82,), # 'о': 'ᲂ'
    # CYRILLIC SMALL LETTER ES: CYRILLIC SMALL LETTER WIDE ES
    0x0441: (0x1c83,), # 'с': 'ᲃ'
    # CYRILLIC SMALL LETTER TE: CYRILLIC SMALL LETTER TALL TE, CYRILLIC SMALL LETTER THREE-LEGGED TE
    0x0442: (0x1c84, 0x1c85), # 'т': 'ᲄᲅ'
    # CYRILLIC SMALL LETTER HARD SIGN: CYRILLIC SMALL LETTER TALL HARD SIGN
    0x044a: (0x1c86,), # 'ъ': 'ᲆ'
    # CYRILLIC SMALL LETTER YAT: CYRILLIC SMALL LETTER TALL YAT
    0x0463: (0x1c87,), # 'ѣ': 'ᲇ'
    # CYRILLIC SMALL LETTER ROUNDED VE: CYRILLIC SMALL LETTER VE
    0x1c80: (0x0432,), # 'ᲀ': 'в'
    # CYRILLIC SMALL LETTER LONG-LEGGED DE: CYRILLIC SMALL LETTER DE
    0x1c81: (0x0434,), # 'ᲁ': 'д'
    # CYRILLIC SMALL LETTER NARROW O: CYRILLIC SMALL LETTER O
    0x1c82: (0x043e,), # 'ᲂ': 'о'
    # CYRILLIC SMALL LETTER WIDE ES: CYRILLIC SMALL LETTER ES
    0x1c83: (0x0441,), # 'ᲃ': 'с'
    # CYRILLIC SMALL LETTER TALL TE: CYRILLIC SMALL LETTER TE, CYRILLIC SMALL LETTER THREE-LEGGED TE
    0x1c84: (0x0442, 0x1c85), # 'ᲄ': 'тᲅ'
    # CYRILLIC SMALL LETTER THREE-LEGGED TE: CYRILLIC SMALL LETTER TE, CYRILLIC SMALL LETTER TALL TE
    0x1c85: (0x0442, 0x1c84), # 'ᲅ': 'тᲄ'
    # CYRILLIC SMALL LETTER TALL HARD SIGN: CYRILLIC SMALL LETTER HARD SIGN
    0x1c86: (0x044a,), # 'ᲆ': 'ъ'
    # CYRILLIC SMALL LETTER TALL YAT: CYRILLIC SMALL LETTER YAT
    0x1c87: (0x0463,), # 'ᲇ': 'ѣ'
    # CYRILLIC SMALL LETTER UNBLENDED UK: CYRILLIC SMALL LETTER MONOGRAPH UK
    0x1c88: (0xa64b,), # 'ᲈ': 'ꙋ'
    # LATIN SMALL LETTER S WITH DOT ABOVE: LATIN SMALL LETTER LONG S WITH DOT ABOVE
    0x1e61: (0x1e9b,), # 'ṡ': 'ẛ'
    # LATIN SMALL LETTER LONG S WITH DOT ABOVE: LATIN SMALL LETTER S WITH DOT ABOVE
    0x1e9b: (0x1e61,), # 'ẛ': 'ṡ'
    # GREEK PROSGEGRAMMENI: COMBINING GREEK YPOGEGRAMMENI, GREEK SMALL LETTER IOTA
    0x1fbe: (0x0345, 0x03b9), # 'ι': '\u0345ι'
    # GREEK SMALL LETTER IOTA WITH DIALYTIKA AND OXIA: GREEK SMALL LETTER IOTA WITH DIALYTIKA AND TONOS
    0x1fd3: (0x0390,), # 'ΐ': 'ΐ'
    # GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND OXIA: GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND TONOS
    0x1fe3: (0x03b0,), # 'ΰ': 'ΰ'
    # CYRILLIC SMALL LETTER MONOGRAPH UK: CYRILLIC SMALL LETTER UNBLENDED UK
    0xa64b: (0x1c88,), # 'ꙋ': 'ᲈ'
    # LATIN SMALL LIGATURE LONG S T: LATIN SMALL LIGATURE ST
    0xfb05: (0xfb06,), # 'ﬅ': 'ﬆ'
    # LATIN SMALL LIGATURE ST: LATIN SMALL LIGATURE LONG S T
    0xfb06: (0xfb05,), # 'ﬆ': 'ﬅ'
}
`;

const COMPILER = String.raw`#
# Secret Labs' Regular Expression Engine
#
# convert template to internal format
#
# Copyright (c) 1997-2001 by Secret Labs AB.  All rights reserved.
#
# See the __init__.py file for information on usage and redistribution.
#

"""Internal support module for sre"""

import _sre
from re import _parser
from re._constants import *
from re._casefix import _EXTRA_CASES

assert _sre.MAGIC == MAGIC, "SRE module mismatch"

_LITERAL_CODES = {LITERAL, NOT_LITERAL}
_SUCCESS_CODES = {SUCCESS, FAILURE}
_ASSERT_CODES = {ASSERT, ASSERT_NOT}
_UNIT_CODES = _LITERAL_CODES | {ANY, IN}

_REPEATING_CODES = {
    MIN_REPEAT: (REPEAT, MIN_UNTIL, MIN_REPEAT_ONE),
    MAX_REPEAT: (REPEAT, MAX_UNTIL, REPEAT_ONE),
    POSSESSIVE_REPEAT: (POSSESSIVE_REPEAT, SUCCESS, POSSESSIVE_REPEAT_ONE),
}

_CHARSET_ALL = [(NEGATE, None)]

def _combine_flags(flags, add_flags, del_flags,
                   TYPE_FLAGS=_parser.TYPE_FLAGS):
    if add_flags & TYPE_FLAGS:
        flags &= ~TYPE_FLAGS
    return (flags | add_flags) & ~del_flags

def _compile(code, pattern, flags):
    # internal: compile a (sub)pattern
    emit = code.append
    _len = len
    LITERAL_CODES = _LITERAL_CODES
    REPEATING_CODES = _REPEATING_CODES
    SUCCESS_CODES = _SUCCESS_CODES
    ASSERT_CODES = _ASSERT_CODES
    iscased = None
    tolower = None
    fixes = None
    if flags & SRE_FLAG_IGNORECASE and not flags & SRE_FLAG_LOCALE:
        if flags & SRE_FLAG_UNICODE:
            iscased = _sre.unicode_iscased
            tolower = _sre.unicode_tolower
            fixes = _EXTRA_CASES
        else:
            iscased = _sre.ascii_iscased
            tolower = _sre.ascii_tolower
    for op, av in pattern:
        if op in LITERAL_CODES:
            if not flags & SRE_FLAG_IGNORECASE:
                emit(op)
                emit(av)
            elif flags & SRE_FLAG_LOCALE:
                emit(OP_LOCALE_IGNORE[op])
                emit(av)
            elif not iscased(av):
                emit(op)
                emit(av)
            else:
                lo = tolower(av)
                if not fixes:  # ascii
                    emit(OP_IGNORE[op])
                    emit(lo)
                elif lo not in fixes:
                    emit(OP_UNICODE_IGNORE[op])
                    emit(lo)
                else:
                    emit(IN_UNI_IGNORE)
                    skip = _len(code); emit(0)
                    if op is NOT_LITERAL:
                        emit(NEGATE)
                    for k in (lo,) + fixes[lo]:
                        emit(LITERAL)
                        emit(k)
                    emit(FAILURE)
                    code[skip] = _len(code) - skip
        elif op is IN:
            charset, hascased = _optimize_charset(av, iscased, tolower, fixes)
            if not charset:
                emit(FAILURE)
            elif charset == _CHARSET_ALL:
                emit(ANY_ALL)
            else:
                if flags & SRE_FLAG_IGNORECASE and flags & SRE_FLAG_LOCALE:
                    emit(IN_LOC_IGNORE)
                elif not hascased:
                    emit(IN)
                elif not fixes:  # ascii
                    emit(IN_IGNORE)
                else:
                    emit(IN_UNI_IGNORE)
                skip = _len(code); emit(0)
                _compile_charset(charset, flags, code)
                code[skip] = _len(code) - skip
        elif op is ANY:
            if flags & SRE_FLAG_DOTALL:
                emit(ANY_ALL)
            else:
                emit(ANY)
        elif op in REPEATING_CODES:
            if _simple(av[2]):
                emit(REPEATING_CODES[op][2])
                skip = _len(code); emit(0)
                emit(av[0])
                emit(av[1])
                _compile(code, av[2], flags)
                emit(SUCCESS)
                code[skip] = _len(code) - skip
            else:
                emit(REPEATING_CODES[op][0])
                skip = _len(code); emit(0)
                emit(av[0])
                emit(av[1])
                _compile(code, av[2], flags)
                code[skip] = _len(code) - skip
                emit(REPEATING_CODES[op][1])
        elif op is SUBPATTERN:
            group, add_flags, del_flags, p = av
            if group:
                emit(MARK)
                emit((group-1)*2)
            # _compile_info(code, p, _combine_flags(flags, add_flags, del_flags))
            _compile(code, p, _combine_flags(flags, add_flags, del_flags))
            if group:
                emit(MARK)
                emit((group-1)*2+1)
        elif op is ATOMIC_GROUP:
            # Atomic Groups are handled by starting with an Atomic
            # Group op code, then putting in the atomic group pattern
            # and finally a success op code to tell any repeat
            # operations within the Atomic Group to stop eating and
            # pop their stack if they reach it
            emit(ATOMIC_GROUP)
            skip = _len(code); emit(0)
            _compile(code, av, flags)
            emit(SUCCESS)
            code[skip] = _len(code) - skip
        elif op in SUCCESS_CODES:
            emit(op)
        elif op in ASSERT_CODES:
            emit(op)
            skip = _len(code); emit(0)
            if av[0] >= 0:
                emit(0) # look ahead
            else:
                lo, hi = av[1].getwidth()
                if lo > MAXCODE:
                    raise error("looks too much behind")
                if lo != hi:
                    raise PatternError("look-behind requires fixed-width pattern")
                emit(lo) # look behind
            _compile(code, av[1], flags)
            emit(SUCCESS)
            code[skip] = _len(code) - skip
        elif op is AT:
            emit(op)
            if flags & SRE_FLAG_MULTILINE:
                av = AT_MULTILINE.get(av, av)
            if flags & SRE_FLAG_LOCALE:
                av = AT_LOCALE.get(av, av)
            elif flags & SRE_FLAG_UNICODE:
                av = AT_UNICODE.get(av, av)
            emit(av)
        elif op is BRANCH:
            emit(op)
            tail = []
            tailappend = tail.append
            for av in av[1]:
                skip = _len(code); emit(0)
                # _compile_info(code, av, flags)
                _compile(code, av, flags)
                emit(JUMP)
                tailappend(_len(code)); emit(0)
                code[skip] = _len(code) - skip
            emit(FAILURE) # end of branch
            for tail in tail:
                code[tail] = _len(code) - tail
        elif op is CATEGORY:
            emit(op)
            if flags & SRE_FLAG_LOCALE:
                av = CH_LOCALE[av]
            elif flags & SRE_FLAG_UNICODE:
                av = CH_UNICODE[av]
            emit(av)
        elif op is GROUPREF:
            if not flags & SRE_FLAG_IGNORECASE:
                emit(op)
            elif flags & SRE_FLAG_LOCALE:
                emit(GROUPREF_LOC_IGNORE)
            elif not fixes:  # ascii
                emit(GROUPREF_IGNORE)
            else:
                emit(GROUPREF_UNI_IGNORE)
            emit(av-1)
        elif op is GROUPREF_EXISTS:
            emit(op)
            emit(av[0]-1)
            skipyes = _len(code); emit(0)
            _compile(code, av[1], flags)
            if av[2]:
                emit(JUMP)
                skipno = _len(code); emit(0)
                code[skipyes] = _len(code) - skipyes + 1
                _compile(code, av[2], flags)
                code[skipno] = _len(code) - skipno
            else:
                code[skipyes] = _len(code) - skipyes + 1
        else:
            raise PatternError(f"internal: unsupported operand type {op!r}")

def _compile_charset(charset, flags, code):
    # compile charset subprogram
    emit = code.append
    for op, av in charset:
        emit(op)
        if op is NEGATE:
            pass
        elif op is LITERAL:
            emit(av)
        elif op is RANGE or op is RANGE_UNI_IGNORE:
            emit(av[0])
            emit(av[1])
        elif op is CHARSET:
            code.extend(av)
        elif op is BIGCHARSET:
            code.extend(av)
        elif op is CATEGORY:
            if flags & SRE_FLAG_LOCALE:
                emit(CH_LOCALE[av])
            elif flags & SRE_FLAG_UNICODE:
                emit(CH_UNICODE[av])
            else:
                emit(av)
        else:
            raise PatternError(f"internal: unsupported set operator {op!r}")
    emit(FAILURE)

def _optimize_charset(charset, iscased=None, fixup=None, fixes=None):
    # internal: optimize character set
    out = []
    tail = []
    charmap = bytearray(256)
    hascased = False
    for op, av in charset:
        while True:
            try:
                if op is LITERAL:
                    if fixup: # IGNORECASE and not LOCALE
                        av = fixup(av)
                        charmap[av] = 1
                        if fixes and av in fixes:
                            for k in fixes[av]:
                                charmap[k] = 1
                        if not hascased and iscased(av):
                            hascased = True
                    else:
                        charmap[av] = 1
                elif op is RANGE:
                    r = range(av[0], av[1]+1)
                    if fixup: # IGNORECASE and not LOCALE
                        if fixes:
                            for i in map(fixup, r):
                                charmap[i] = 1
                                if i in fixes:
                                    for k in fixes[i]:
                                        charmap[k] = 1
                        else:
                            for i in map(fixup, r):
                                charmap[i] = 1
                        if not hascased:
                            hascased = any(map(iscased, r))
                    else:
                        for i in r:
                            charmap[i] = 1
                elif op is NEGATE:
                    out.append((op, av))
                elif op is CATEGORY and tail and (CATEGORY, CH_NEGATE[av]) in tail:
                    # Optimize [\s\S] etc.
                    out = [] if out else _CHARSET_ALL
                    return out, False
                else:
                    tail.append((op, av))
            except IndexError:
                if len(charmap) == 256:
                    # character set contains non-UCS1 character codes
                    charmap += b'\0' * 0xff00
                    continue
                # Character set contains non-BMP character codes.
                # For range, all BMP characters in the range are already
                # proceeded.
                if fixup: # IGNORECASE and not LOCALE
                    # For now, IN_UNI_IGNORE+LITERAL and
                    # IN_UNI_IGNORE+RANGE_UNI_IGNORE work for all non-BMP
                    # characters, because two characters (at least one of
                    # which is not in the BMP) match case-insensitively
                    # if and only if:
                    # 1) c1.lower() == c2.lower()
                    # 2) c1.lower() == c2 or c1.lower().upper() == c2
                    # Also, both c.lower() and c.lower().upper() are single
                    # characters for every non-BMP character.
                    if op is RANGE:
                        if fixes: # not ASCII
                            op = RANGE_UNI_IGNORE
                        hascased = True
                    else:
                        assert op is LITERAL
                        if not hascased and iscased(av):
                            hascased = True
                tail.append((op, av))
            break

    # compress character map
    runs = []
    q = 0
    while True:
        p = charmap.find(1, q)
        if p < 0:
            break
        if len(runs) >= 2:
            runs = None
            break
        q = charmap.find(0, p)
        if q < 0:
            runs.append((p, len(charmap)))
            break
        runs.append((p, q))
    if runs is not None:
        # use literal/range
        for p, q in runs:
            if q - p == 1:
                out.append((LITERAL, p))
            else:
                out.append((RANGE, (p, q - 1)))
        out += tail
        # if the case was changed or new representation is more compact
        if hascased or len(out) < len(charset):
            return out, hascased
        # else original character set is good enough
        return charset, hascased

    # use bitmap
    if len(charmap) == 256:
        data = _mk_bitmap(charmap)
        out.append((CHARSET, data))
        out += tail
        return out, hascased

    # To represent a big charset, first a bitmap of all characters in the
    # set is constructed. Then, this bitmap is sliced into chunks of 256
    # characters, duplicate chunks are eliminated, and each chunk is
    # given a number. In the compiled expression, the charset is
    # represented by a 32-bit word sequence, consisting of one word for
    # the number of different chunks, a sequence of 256 bytes (64 words)
    # of chunk numbers indexed by their original chunk position, and a
    # sequence of 256-bit chunks (8 words each).

    # Compression is normally good: in a typical charset, large ranges of
    # Unicode will be either completely excluded (e.g. if only cyrillic
    # letters are to be matched), or completely included (e.g. if large
    # subranges of Kanji match). These ranges will be represented by
    # chunks of all one-bits or all zero-bits.

    # Matching can be also done efficiently: the more significant byte of
    # the Unicode character is an index into the chunk number, and the
    # less significant byte is a bit index in the chunk (just like the
    # CHARSET matching).

    charmap = bytes(charmap) # should be hashable
    comps = {}
    mapping = bytearray(256)
    block = 0
    data = bytearray()
    for i in range(0, 65536, 256):
        chunk = charmap[i: i + 256]
        if chunk in comps:
            mapping[i // 256] = comps[chunk]
        else:
            mapping[i // 256] = comps[chunk] = block
            block += 1
            data += chunk
    data = _mk_bitmap(data)
    data[0:0] = [block] + _bytes_to_codes(mapping)
    out.append((BIGCHARSET, data))
    out += tail
    return out, hascased

_CODEBITS = _sre.CODESIZE * 8
MAXCODE = (1 << _CODEBITS) - 1
_BITS_TRANS = b'0' + b'1' * 255
def _mk_bitmap(bits, _CODEBITS=_CODEBITS, _int=int):
    s = bits.translate(_BITS_TRANS)[::-1]
    return [_int(s[i - _CODEBITS: i], 2)
            for i in range(len(s), 0, -_CODEBITS)]

def _bytes_to_codes(b):
    # Convert block indices to word array
    a = memoryview(b).cast('I')
    assert a.itemsize == _sre.CODESIZE
    assert len(a) * a.itemsize == len(b)
    return a.tolist()

def _simple(p):
    # check if this subpattern is a "simple" operator
    if len(p) != 1:
        return False
    op, av = p[0]
    if op is SUBPATTERN:
        return av[0] is None and _simple(av[-1])
    return op in _UNIT_CODES

def _generate_overlap_table(prefix):
    """
    Generate an overlap table for the following prefix.
    An overlap table is a table of the same size as the prefix which
    informs about the potential self-overlap for each index in the prefix:
    - if overlap[i] == 0, prefix[i:] can't overlap prefix[0:...]
    - if overlap[i] == k with 0 < k <= i, prefix[i-k+1:i+1] overlaps with
      prefix[0:k]
    """
    table = [0] * len(prefix)
    for i in range(1, len(prefix)):
        idx = table[i - 1]
        while prefix[i] != prefix[idx]:
            if idx == 0:
                table[i] = 0
                break
            idx = table[idx - 1]
        else:
            table[i] = idx + 1
    return table

def _get_iscased(flags):
    if not flags & SRE_FLAG_IGNORECASE:
        return None
    elif flags & SRE_FLAG_UNICODE:
        return _sre.unicode_iscased
    else:
        return _sre.ascii_iscased

def _get_literal_prefix(pattern, flags):
    # look for literal prefix
    prefix = []
    prefixappend = prefix.append
    prefix_skip = None
    iscased = _get_iscased(flags)
    for op, av in pattern.data:
        if op is LITERAL:
            if iscased and iscased(av):
                break
            prefixappend(av)
        elif op is SUBPATTERN:
            group, add_flags, del_flags, p = av
            flags1 = _combine_flags(flags, add_flags, del_flags)
            if flags1 & SRE_FLAG_IGNORECASE and flags1 & SRE_FLAG_LOCALE:
                break
            prefix1, prefix_skip1, got_all = _get_literal_prefix(p, flags1)
            if prefix_skip is None:
                if group is not None:
                    prefix_skip = len(prefix)
                elif prefix_skip1 is not None:
                    prefix_skip = len(prefix) + prefix_skip1
            prefix.extend(prefix1)
            if not got_all:
                break
        else:
            break
    else:
        return prefix, prefix_skip, True
    return prefix, prefix_skip, False

def _get_charset_prefix(pattern, flags):
    while True:
        if not pattern.data:
            return None
        op, av = pattern.data[0]
        if op is not SUBPATTERN:
            break
        group, add_flags, del_flags, pattern = av
        flags = _combine_flags(flags, add_flags, del_flags)
        if flags & SRE_FLAG_IGNORECASE and flags & SRE_FLAG_LOCALE:
            return None

    iscased = _get_iscased(flags)
    if op is LITERAL:
        if iscased and iscased(av):
            return None
        return [(op, av)]
    elif op is BRANCH:
        charset = []
        charsetappend = charset.append
        for p in av[1]:
            if not p:
                return None
            op, av = p[0]
            if op is LITERAL and not (iscased and iscased(av)):
                charsetappend((op, av))
            else:
                return None
        return charset
    elif op is IN:
        charset = av
        if iscased:
            for op, av in charset:
                if op is LITERAL:
                    if iscased(av):
                        return None
                elif op is RANGE:
                    if av[1] > 0xffff:
                        return None
                    if any(map(iscased, range(av[0], av[1]+1))):
                        return None
        return charset
    return None

def _compile_info(code, pattern, flags):
    # internal: compile an info block.  in the current version,
    # this contains min/max pattern width, and an optional literal
    # prefix or a character map
    lo, hi = pattern.getwidth()
    if hi > MAXCODE:
        hi = MAXCODE
    if lo == 0:
        code.extend([INFO, 4, 0, lo, hi])
        return
    # look for a literal prefix
    prefix = []
    prefix_skip = 0
    charset = None # not used
    if not (flags & SRE_FLAG_IGNORECASE and flags & SRE_FLAG_LOCALE):
        # look for literal prefix
        prefix, prefix_skip, got_all = _get_literal_prefix(pattern, flags)
        # if no prefix, look for charset prefix
        if not prefix:
            charset = _get_charset_prefix(pattern, flags)
            if charset:
                charset, hascased = _optimize_charset(charset)
                assert not hascased
                if charset == _CHARSET_ALL:
                    charset = None
##     if prefix:
##         print("*** PREFIX", prefix, prefix_skip)
##     if charset:
##         print("*** CHARSET", charset)
    # add an info block
    emit = code.append
    emit(INFO)
    skip = len(code); emit(0)
    # literal flag
    mask = 0
    if prefix:
        mask = SRE_INFO_PREFIX
        if prefix_skip is None and got_all:
            mask = mask | SRE_INFO_LITERAL
    elif charset:
        mask = mask | SRE_INFO_CHARSET
    emit(mask)
    # pattern length
    if lo < MAXCODE:
        emit(lo)
    else:
        emit(MAXCODE)
        prefix = prefix[:MAXCODE]
    emit(hi)
    # add literal prefix
    if prefix:
        emit(len(prefix)) # length
        if prefix_skip is None:
            prefix_skip =  len(prefix)
        emit(prefix_skip) # skip
        code.extend(prefix)
        # generate overlap table
        code.extend(_generate_overlap_table(prefix))
    elif charset:
        _compile_charset(charset, flags, code)
    code[skip] = len(code) - skip

def isstring(obj):
    return isinstance(obj, (str, bytes))

def _code(p, flags):

    flags = p.state.flags | flags
    code = []

    # compile info block
    _compile_info(code, p, flags)

    # compile the pattern
    _compile(code, p.data, flags)

    code.append(SUCCESS)

    return code

def _hex_code(code):
    return '[%s]' % ', '.join('%#0*x' % (_sre.CODESIZE*2+2, x) for x in code)

def dis(code):
    import sys

    labels = set()
    level = 0
    offset_width = len(str(len(code) - 1))

    def dis_(start, end):
        def print_(*args, to=None):
            if to is not None:
                labels.add(to)
                args += ('(to %d)' % (to,),)
            print('%*d%s ' % (offset_width, start, ':' if start in labels else '.'),
                  end='  '*(level-1))
            print(*args)

        def print_2(*args):
            print(end=' '*(offset_width + 2*level))
            print(*args)

        nonlocal level
        level += 1
        i = start
        while i < end:
            start = i
            op = code[i]
            i += 1
            op = OPCODES[op]
            if op in (SUCCESS, FAILURE, ANY, ANY_ALL,
                      MAX_UNTIL, MIN_UNTIL, NEGATE):
                print_(op)
            elif op in (LITERAL, NOT_LITERAL,
                        LITERAL_IGNORE, NOT_LITERAL_IGNORE,
                        LITERAL_UNI_IGNORE, NOT_LITERAL_UNI_IGNORE,
                        LITERAL_LOC_IGNORE, NOT_LITERAL_LOC_IGNORE):
                arg = code[i]
                i += 1
                print_(op, '%#02x (%r)' % (arg, chr(arg)))
            elif op is AT:
                arg = code[i]
                i += 1
                arg = str(ATCODES[arg])
                assert arg[:3] == 'AT_'
                print_(op, arg[3:])
            elif op is CATEGORY:
                arg = code[i]
                i += 1
                arg = str(CHCODES[arg])
                assert arg[:9] == 'CATEGORY_'
                print_(op, arg[9:])
            elif op in (IN, IN_IGNORE, IN_UNI_IGNORE, IN_LOC_IGNORE):
                skip = code[i]
                print_(op, skip, to=i+skip)
                dis_(i+1, i+skip)
                i += skip
            elif op in (RANGE, RANGE_UNI_IGNORE):
                lo, hi = code[i: i+2]
                i += 2
                print_(op, '%#02x %#02x (%r-%r)' % (lo, hi, chr(lo), chr(hi)))
            elif op is CHARSET:
                print_(op, _hex_code(code[i: i + 256//_CODEBITS]))
                i += 256//_CODEBITS
            elif op is BIGCHARSET:
                arg = code[i]
                i += 1
                mapping = list(b''.join(x.to_bytes(_sre.CODESIZE, sys.byteorder)
                                        for x in code[i: i + 256//_sre.CODESIZE]))
                print_(op, arg, mapping)
                i += 256//_sre.CODESIZE
                level += 1
                for j in range(arg):
                    print_2(_hex_code(code[i: i + 256//_CODEBITS]))
                    i += 256//_CODEBITS
                level -= 1
            elif op in (MARK, GROUPREF, GROUPREF_IGNORE, GROUPREF_UNI_IGNORE,
                        GROUPREF_LOC_IGNORE):
                arg = code[i]
                i += 1
                print_(op, arg)
            elif op is JUMP:
                skip = code[i]
                print_(op, skip, to=i+skip)
                i += 1
            elif op is BRANCH:
                skip = code[i]
                print_(op, skip, to=i+skip)
                while skip:
                    dis_(i+1, i+skip)
                    i += skip
                    start = i
                    skip = code[i]
                    if skip:
                        print_('branch', skip, to=i+skip)
                    else:
                        print_(FAILURE)
                i += 1
            elif op in (REPEAT, REPEAT_ONE, MIN_REPEAT_ONE,
                        POSSESSIVE_REPEAT, POSSESSIVE_REPEAT_ONE):
                skip, min, max = code[i: i+3]
                if max == MAXREPEAT:
                    max = 'MAXREPEAT'
                print_(op, skip, min, max, to=i+skip)
                dis_(i+3, i+skip)
                i += skip
            elif op is GROUPREF_EXISTS:
                arg, skip = code[i: i+2]
                print_(op, arg, skip, to=i+skip)
                i += 2
            elif op in (ASSERT, ASSERT_NOT):
                skip, arg = code[i: i+2]
                print_(op, skip, arg, to=i+skip)
                dis_(i+2, i+skip)
                i += skip
            elif op is ATOMIC_GROUP:
                skip = code[i]
                print_(op, skip, to=i+skip)
                dis_(i+1, i+skip)
                i += skip
            elif op is INFO:
                skip, flags, min, max = code[i: i+4]
                if max == MAXREPEAT:
                    max = 'MAXREPEAT'
                print_(op, skip, bin(flags), min, max, to=i+skip)
                start = i+4
                if flags & SRE_INFO_PREFIX:
                    prefix_len, prefix_skip = code[i+4: i+6]
                    print_2('  prefix_skip', prefix_skip)
                    start = i + 6
                    prefix = code[start: start+prefix_len]
                    print_2('  prefix',
                            '[%s]' % ', '.join('%#02x' % x for x in prefix),
                            '(%r)' % ''.join(map(chr, prefix)))
                    start += prefix_len
                    print_2('  overlap', code[start: start+prefix_len])
                    start += prefix_len
                if flags & SRE_INFO_CHARSET:
                    level += 1
                    print_2('in')
                    dis_(start, i+skip)
                    level -= 1
                i += skip
            else:
                raise ValueError(op)

        level -= 1

    dis_(0, len(code))


def compile(p, flags=0):
    # internal: convert pattern list to internal format

    if isstring(p):
        pattern = p
        p = _parser.parse(p, flags)
    else:
        pattern = None

    code = _code(p, flags)

    if flags & SRE_FLAG_DEBUG:
        print()
        dis(code)

    # map in either direction
    groupindex = p.state.groupdict
    indexgroup = [None] * p.state.groups
    for k, i in groupindex.items():
        indexgroup[i] = k

    return _sre.compile(
        pattern, flags | p.state.flags, code,
        p.state.groups-1,
        groupindex, tuple(indexgroup)
        )
`;

// CPython's `sre_parse.py`, of which `sre_constants.py` and `sre_compile.py` differ only in the module they copy.

const DEPRECATED_ALIAS = String.raw`import warnings
warnings.warn(f"module {__name__!r} is deprecated",
              DeprecationWarning,
              stacklevel=2)

from re import _parser as _
globals().update({k: v for k, v in vars(_).items() if k[:2] != '__'})
`;

registerSourceModule('re._constants', CONSTANTS);
registerSourceModule('re._parser', PARSER);
registerSourceModule('re._casefix', CASEFIX);
registerSourceModule('re._compiler', COMPILER);
for (const [name, part] of [
  ['sre_constants', '_constants'],
  ['sre_parse', '_parser'],
  ['sre_compile', '_compiler'],
]) {
  registerSourceModule(name, DEPRECATED_ALIAS.replace('_parser', part));
}
