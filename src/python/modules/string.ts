import { builtin } from '../define';
import { decimalValue } from '../numbers';
import { registerSourceModule } from '../sourceModules';
import { iteratorClass, newTuple, None, pyError, typeError, typeName } from '../types';
import { DONE, PyIterator, type PyValue } from '../values';

// CPython's `string` module, with natives standing in for the helpers of its `_string` module.
const SOURCE =
  String.raw`
"""A collection of string constants.

Public module variables:

whitespace -- a string containing all ASCII whitespace
ascii_lowercase -- a string containing all ASCII lowercase letters
ascii_uppercase -- a string containing all ASCII uppercase letters
ascii_letters -- a string containing all ASCII letters
digits -- a string containing all ASCII decimal digits
hexdigits -- a string containing all ASCII hexadecimal digits
octdigits -- a string containing all ASCII octal digits
punctuation -- a string containing all ASCII punctuation characters
printable -- a string containing all ASCII characters considered printable

"""

__all__ = ["ascii_letters", "ascii_lowercase", "ascii_uppercase", "capwords",
           "digits", "hexdigits", "octdigits", "printable", "punctuation",
           "whitespace", "Formatter", "Template"]

class _string:
    formatter_parser = _formatter_parser
    formatter_field_name_split = _formatter_field_name_split

del _formatter_parser, _formatter_field_name_split


# Some strings for ctype-style character classification
whitespace = ' \t\n\r\v\f'
ascii_lowercase = 'abcdefghijklmnopqrstuvwxyz'
ascii_uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
ascii_letters = ascii_lowercase + ascii_uppercase
digits = '0123456789'
hexdigits = digits + 'abcdef' + 'ABCDEF'
octdigits = '01234567'
punctuation = r"""!"#$%&'()*+,-./:;<=>?@[\]^_` +
  '`' +
  String.raw`{|}~"""
printable = digits + ascii_letters + punctuation + whitespace

# Functions which aren't available as string methods.

# Capitalize the words in a string, e.g. " aBc  dEf " -> "Abc Def".
def capwords(s, sep=None):
    """capwords(s [,sep]) -> string

    Split the argument into words using split, capitalize each
    word using capitalize, and join the capitalized words using
    join.  If the optional second argument sep is absent or None,
    runs of whitespace characters are replaced by a single space
    and leading and trailing whitespace are removed, otherwise
    sep is used to split and join the words.

    """
    return (sep or ' ').join(map(str.capitalize, s.split(sep)))


####################################################################
_sentinel_dict = {}


class _TemplatePattern:
    # This descriptor is overwritten in ` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`Template._compile_pattern()` +
  '`' +
  String.raw`` +
  '`' +
  String.raw`.
    def __get__(self, instance, cls=None):
        if cls is None:
            return self
        return cls._compile_pattern()
_TemplatePattern = _TemplatePattern()


class Template:
    """A string class for supporting $-substitutions."""

    delimiter = '$'
    # r'[a-z]' matches to non-ASCII letters when used with IGNORECASE, but
    # without the ASCII flag.  We can't add re.ASCII to flags because of
    # backward compatibility.  So we use the ?a local flag and [a-z] pattern.
    # See https://bugs.python.org/issue31672
    idpattern = r'(?a:[_a-z][_a-z0-9]*)'
    braceidpattern = None
    flags = None  # default: re.IGNORECASE

    pattern = _TemplatePattern  # use a descriptor to compile the pattern

    def __init_subclass__(cls):
        super().__init_subclass__()
        cls._compile_pattern()

    @classmethod
    def _compile_pattern(cls):
        import re  # deferred import, for performance

        # ` +
  '`' +
  String.raw`pattern` +
  '`' +
  String.raw` may be the ` +
  '`' +
  String.raw`_TemplatePattern` +
  '`' +
  String.raw` sentinel (not yet compiled), an
        # already-compiled regular expression object (as documented), or a string
        # regular expression.  An already-compiled object is returned as-is; the
        # other two are compiled and cached back on the class.
        pattern = cls.__dict__.get('pattern', _TemplatePattern)
        if isinstance(pattern, re.Pattern):
            # re.compile() rejects flags on an already-compiled pattern.
            return pattern
        if pattern is _TemplatePattern:
            delim = re.escape(cls.delimiter)
            id = cls.idpattern
            bid = cls.braceidpattern or cls.idpattern
            pattern = fr"""
            {delim}(?:
              (?P<escaped>{delim})  |   # Escape sequence of two delimiters
              (?P<named>{id})       |   # delimiter and a Python identifier
              {{(?P<braced>{bid})}} |   # delimiter and a braced identifier
              (?P<invalid>)             # Other ill-formed delimiter exprs
            )
            """
        if cls.flags is None:
            cls.flags = re.IGNORECASE
        pat = cls.pattern = re.compile(pattern, cls.flags | re.VERBOSE)
        return pat

    def __init__(self, template):
        self.template = template

    # Search for $$, $identifier, $` +
  String.raw`{identifier}, and any bare $'s

    def _invalid(self, mo):
        i = mo.start('invalid')
        lines = self.template[:i].splitlines(keepends=True)
        if not lines:
            colno = 1
            lineno = 1
        else:
            colno = i - len(''.join(lines[:-1]))
            lineno = len(lines)
        raise ValueError('Invalid placeholder in string: line %d, col %d' %
                         (lineno, colno))

    def substitute(self, mapping=_sentinel_dict, /, **kws):
        if mapping is _sentinel_dict:
            mapping = kws
        elif kws:
            from collections import ChainMap
            mapping = ChainMap(kws, mapping)
        # Helper function for .sub()
        def convert(mo):
            # Check the most common path first.
            named = mo.group('named') or mo.group('braced')
            if named is not None:
                return str(mapping[named])
            if mo.group('escaped') is not None:
                return self.delimiter
            if mo.group('invalid') is not None:
                self._invalid(mo)
            raise ValueError('Unrecognized named group in pattern',
                             self.pattern)
        return self.pattern.sub(convert, self.template)

    def safe_substitute(self, mapping=_sentinel_dict, /, **kws):
        if mapping is _sentinel_dict:
            mapping = kws
        elif kws:
            from collections import ChainMap
            mapping = ChainMap(kws, mapping)
        # Helper function for .sub()
        def convert(mo):
            named = mo.group('named') or mo.group('braced')
            if named is not None:
                try:
                    return str(mapping[named])
                except KeyError:
                    return mo.group()
            if mo.group('escaped') is not None:
                return self.delimiter
            if mo.group('invalid') is not None:
                return mo.group()
            raise ValueError('Unrecognized named group in pattern',
                             self.pattern)
        return self.pattern.sub(convert, self.template)

    def is_valid(self):
        for mo in self.pattern.finditer(self.template):
            if mo.group('invalid') is not None:
                return False
            if (mo.group('named') is None
                and mo.group('braced') is None
                and mo.group('escaped') is None):
                # If all the groups are None, there must be
                # another group we're not expecting
                raise ValueError('Unrecognized named group in pattern',
                    self.pattern)
        return True

    def get_identifiers(self):
        ids = []
        for mo in self.pattern.finditer(self.template):
            named = mo.group('named') or mo.group('braced')
            if named is not None and named not in ids:
                # add a named group only the first time it appears
                ids.append(named)
            elif (named is None
                and mo.group('invalid') is None
                and mo.group('escaped') is None):
                # If all the groups are None, there must be
                # another group we're not expecting
                raise ValueError('Unrecognized named group in pattern',
                    self.pattern)
        return ids


########################################################################
# the Formatter class
# see PEP 3101 for details and purpose of this class

# The hard parts are reused from the C implementation.  They're exposed as "_"
# prefixed methods of str.

# The overall parser is implemented in _string.formatter_parser.
# The field name parser is implemented in _string.formatter_field_name_split

class Formatter:
    def format(self, format_string, /, *args, **kwargs):
        return self.vformat(format_string, args, kwargs)

    def vformat(self, format_string, args, kwargs):
        used_args = set()
        result, _ = self._vformat(format_string, args, kwargs, used_args, 2)
        self.check_unused_args(used_args, args, kwargs)
        return result

    def _vformat(self, format_string, args, kwargs, used_args, recursion_depth,
                 auto_arg_index=0):
        if recursion_depth < 0:
            raise ValueError('Max string recursion exceeded')
        result = []
        for literal_text, field_name, format_spec, conversion in \
                self.parse(format_string):

            # output the literal text
            if literal_text:
                result.append(literal_text)

            # if there's a field, output it
            if field_name is not None:
                # this is some markup, find the object and do
                #  the formatting

                # handle arg indexing when empty field first parts are given.
                field_first, _ = _string.formatter_field_name_split(field_name)
                if field_first == '':
                    if auto_arg_index is False:
                        raise ValueError('cannot switch from manual field '
                                         'specification to automatic field '
                                         'numbering')
                    field_name = str(auto_arg_index) + field_name
                    auto_arg_index += 1
                elif isinstance(field_first, int):
                    if auto_arg_index:
                        raise ValueError('cannot switch from automatic field '
                                         'numbering to manual field '
                                         'specification')
                    # disable auto arg incrementing, if it gets
                    # used later on, then an exception will be raised
                    auto_arg_index = False

                # given the field_name, find the object it references
                #  and the argument it came from
                obj, arg_used = self.get_field(field_name, args, kwargs)
                used_args.add(arg_used)

                # do any conversion on the resulting object
                obj = self.convert_field(obj, conversion)

                # expand the format spec, if needed
                format_spec, auto_arg_index = self._vformat(
                    format_spec, args, kwargs,
                    used_args, recursion_depth-1,
                    auto_arg_index=auto_arg_index)

                # format the object and append to the result
                result.append(self.format_field(obj, format_spec))

        return ''.join(result), auto_arg_index


    def get_value(self, key, args, kwargs):
        if isinstance(key, int):
            return args[key]
        else:
            return kwargs[key]


    def check_unused_args(self, used_args, args, kwargs):
        pass


    def format_field(self, value, format_spec):
        return format(value, format_spec)


    def convert_field(self, value, conversion):
        # do any conversion on the resulting object
        if conversion is None:
            return value
        elif conversion == 's':
            return str(value)
        elif conversion == 'r':
            return repr(value)
        elif conversion == 'a':
            return ascii(value)
        raise ValueError("Unknown conversion specifier {0!s}".format(conversion))


    # returns an iterable that contains tuples of the form:
    # (literal_text, field_name, format_spec, conversion)
    # literal_text can be zero length
    # field_name can be None, in which case there's no
    #  object to format and output
    # if field_name is not None, it is looked up, formatted
    #  with format_spec and conversion and then used
    def parse(self, format_string):
        return _string.formatter_parser(format_string)


    # given a field_name, find the object it references.
    #  field_name:   the field being looked up, e.g. "0.name"
    #                 or "lookup[3]"
    #  used_args:    a set of which args have been used
    #  args, kwargs: as passed in to vformat
    def get_field(self, field_name, args, kwargs):
        first, rest = _string.formatter_field_name_split(field_name)

        obj = self.get_value(first, args, kwargs)

        # loop through the rest of the field_name, doing
        #  getattr or getitem as needed
        for is_attr, i in rest:
            if is_attr:
                obj = getattr(obj, i)
            else:
                obj = obj[i]

        return obj, first
`;

registerSourceModule(
  'string',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      ['_formatter_parser', builtin('formatter_parser', 'one', 1, 1, ([text]) => formatterParser(text))],
      [
        '_formatter_field_name_split',
        builtin('formatter_field_name_split', 'one', 1, 1, ([text]) => fieldNameSplit(text)),
      ],
    ])
);

// Formatter ---------------------------------------------------------------------------------------------------------

/** `_string.formatter_parser`: the (literal, field name, format spec, conversion) tuples of a format string. */
// code-gauge-allow functionCognitiveComplexity 25 -- Follows MarkupIterator_next of CPython's unicode_format.h.
// code-gauge-allow functionNcss 34 -- Follows MarkupIterator_next of CPython's unicode_format.h.
function formatterParser(value: PyValue): PyValue {
  if (typeof value !== 'string') throw typeError(`expected str, got ${typeName(value)}`);
  // oxlint-disable-next-line typescript/no-misused-spread -- CPython parses a format string by code points.
  const chars = [...value];
  let position = 0;
  return new PyIterator(iteratorClass('formatteriterator'), () => {
    if (position >= chars.length) return DONE;
    const start = position;
    let char = '';
    let markup = false;
    while (position < chars.length) {
      char = chars[position++];
      if (char === '{' || char === '}') {
        markup = true;
        break;
      }
    }
    const atEnd = position >= chars.length;
    let length = position - start;
    if (char === '}' && markup && (atEnd || chars[position] !== '}')) {
      throw pyError('ValueError', "Single '}' encountered in format string");
    }
    if (atEnd && char === '{' && markup) throw pyError('ValueError', "Single '{' encountered in format string");
    if (!atEnd && markup) {
      if (chars[position] === char) {
        position++;
        markup = false;
      } else length--;
    }
    const literal = chars.slice(start, start + length).join('');
    if (!markup) return newTuple([literal, None, None, None]);
    const field = parseField(chars, position);
    position = field.end;
    return newTuple([literal, field.name, field.spec, field.conversion ?? None]);
  });
}

interface ParsedField {
  name: string;
  spec: string;
  conversion?: string;
  end: number;
}

/** Reads a replacement field after its `{`, as parse_field of CPython's unicode_format.h does. */
function parseField(chars: string[], start: number): ParsedField {
  let position = start;
  let char = '';
  while (position < chars.length) {
    char = chars[position++];
    if (char === '{') throw pyError('ValueError', "unexpected '{' in field name");
    if (char === '[') {
      while (position < chars.length && chars[position] !== ']') position++;
      continue;
    }
    if (char === '}' || char === ':' || char === '!') break;
  }
  const name = chars.slice(start, position - 1).join('');
  if (char === '!' || char === ':') return parseSpec(chars, position, name, char === '!');
  if (char !== '}') throw pyError('ValueError', "expected '}' before end of string");
  return { name, spec: '', end: position };
}

// code-gauge-allow functionCognitiveComplexity 16 -- Follows parse_field of CPython's unicode_format.h.
/** Reads the conversion and the format spec of a field, up to the `}` that matches its `{`. */
function parseSpec(chars: string[], start: number, name: string, hasConversion: boolean): ParsedField {
  let position = start;
  let conversion: string | undefined;
  if (hasConversion) {
    if (position >= chars.length) throw pyError('ValueError', 'end of string while looking for conversion specifier');
    conversion = chars[position++];
    if (position < chars.length) {
      const next = chars[position++];
      if (next === '}') return { name, spec: '', conversion, end: position };
      if (next !== ':') throw pyError('ValueError', "expected ':' after conversion specifier");
    }
  }
  const specStart = position;
  let depth = 1;
  while (position < chars.length) {
    const next = chars[position++];
    if (next === '{') depth++;
    else if (next === '}' && --depth === 0) {
      return { name, spec: chars.slice(specStart, position - 1).join(''), conversion, end: position };
    }
  }
  throw pyError('ValueError', "unmatched '{' in format spec");
}

/** `_string.formatter_field_name_split`: the first part of a field name and the attributes and keys after it. */
// code-gauge-allow functionCognitiveComplexity 22 -- Follows FieldNameIterator of CPython's unicode_format.h.
// code-gauge-allow functionNcss 31 -- Follows FieldNameIterator of CPython's unicode_format.h.
function fieldNameSplit(value: PyValue): PyValue {
  if (typeof value !== 'string') throw typeError(`expected str, got ${typeName(value)}`);
  let position = 0;
  while (position < value.length && value[position] !== '.' && value[position] !== '[') position++;
  const first = integerOr(value.slice(0, position));
  const iterator = new PyIterator(iteratorClass('fieldnameiterator'), () => {
    if (position >= value.length) return DONE;
    const marker = value[position++];
    if (marker === '.') {
      let stop = position;
      while (stop < value.length && value[stop] !== '.' && value[stop] !== '[') stop++;
      if (stop === position) throw pyError('ValueError', 'Empty attribute in format string');
      const attribute = value.slice(position, stop);
      position = stop;
      return newTuple([true, attribute]);
    }
    if (marker === '[') {
      const stop = value.indexOf(']', position);
      if (stop === -1) throw pyError('ValueError', "Missing ']' in format string");
      const key = value.slice(position, stop);
      if (key === '') throw pyError('ValueError', 'Empty attribute in format string');
      position = stop + 1;
      return newTuple([false, integerOr(key)]);
    }
    throw pyError('ValueError', "Only '.' or '[' may follow ']' in format field specifier");
  });
  return newTuple([first, iterator]);
}

function integerOr(text: string): PyValue {
  const digits = decimalValue(text);
  if (digits === undefined) return text;
  const value = BigInt(digits);
  if (value >= 1n << 63n) throw pyError('ValueError', 'Too many decimal digits in format string');
  return value;
}
