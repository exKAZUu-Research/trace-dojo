/**
 * `capwords`, `Template` and `Formatter` of CPython 3.14's Lib/string/__init__.py in the Python this interpreter runs.
 * The `re` module does not exist here, so the native `_template_scan` finds a template's placeholders as the default
 * pattern does, and a class that changes the pattern is rejected.
 */
export const STRING_SOURCE = String.raw`
def capwords(s, sep=None):
    return (sep or ' ').join(map(str.capitalize, s.split(sep)))


_sentinel_dict = {}


class _TemplatePattern:
    def __get__(self, instance, cls=None):
        _unsupported('string.Template.pattern（re モジュール）')
_TemplatePattern = _TemplatePattern()


class Template:
    delimiter = '$'
    idpattern = r'(?a:[_a-z][_a-z0-9]*)'
    braceidpattern = None
    flags = None

    pattern = _TemplatePattern

    def __init__(self, template):
        self.template = template

    def _scan(self):
        cls = type(self)
        changed = (cls.idpattern != Template.idpattern or cls.braceidpattern is not None
                   or cls.flags is not None)
        for base in cls.__mro__:
            if base is not Template and 'pattern' in base.__dict__:
                changed = True
        if changed:
            _unsupported('string.Template の idpattern・braceidpattern・flags・pattern の変更（re モジュール）')
        return _template_scan(self.template, cls.delimiter)

    def _invalid(self, i):
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
        template = self.template
        result = []
        last = 0
        for start, end, kind, named in self._scan():
            result.append(template[last:start])
            last = end
            if kind == 'named':
                result.append(str(mapping[named]))
            elif kind == 'escaped':
                result.append(self.delimiter)
            else:
                self._invalid(end)
        result.append(template[last:])
        return ''.join(result)

    def safe_substitute(self, mapping=_sentinel_dict, /, **kws):
        if mapping is _sentinel_dict:
            mapping = kws
        elif kws:
            from collections import ChainMap
            mapping = ChainMap(kws, mapping)
        template = self.template
        result = []
        last = 0
        for start, end, kind, named in self._scan():
            result.append(template[last:start])
            last = end
            if kind == 'named':
                try:
                    result.append(str(mapping[named]))
                except KeyError:
                    result.append(template[start:end])
            elif kind == 'escaped':
                result.append(self.delimiter)
            else:
                result.append(template[start:end])
        result.append(template[last:])
        return ''.join(result)

    def is_valid(self):
        for start, end, kind, named in self._scan():
            if kind == 'invalid':
                return False
        return True

    def get_identifiers(self):
        ids = []
        for start, end, kind, named in self._scan():
            if kind == 'named' and named not in ids:
                ids.append(named)
        return ids


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

            if literal_text:
                result.append(literal_text)

            if field_name is not None:
                field_first, _ = _formatter_field_name_split(field_name)
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
                    auto_arg_index = False

                obj, arg_used = self.get_field(field_name, args, kwargs)
                used_args.add(arg_used)

                obj = self.convert_field(obj, conversion)

                format_spec, auto_arg_index = self._vformat(
                    format_spec, args, kwargs,
                    used_args, recursion_depth-1,
                    auto_arg_index=auto_arg_index)

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
        if conversion is None:
            return value
        elif conversion == 's':
            return str(value)
        elif conversion == 'r':
            return repr(value)
        elif conversion == 'a':
            return ascii(value)
        raise ValueError("Unknown conversion specifier {0!s}".format(conversion))

    def parse(self, format_string):
        return _formatter_parser(format_string)

    def get_field(self, field_name, args, kwargs):
        first, rest = _formatter_field_name_split(field_name)

        obj = self.get_value(first, args, kwargs)

        for is_attr, i in rest:
            if is_attr:
                obj = getattr(obj, i)
            else:
                obj = obj[i]

        return obj, first
`;
