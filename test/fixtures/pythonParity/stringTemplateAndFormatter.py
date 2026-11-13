import string
from string import Formatter, Template, capwords


class Percent(Template):
    delimiter = '%'


class Tag(Template):
    delimiter = '<<'


class Lenient(Formatter):
    def __init__(self):
        self.used = []

    def get_value(self, key, args, kwargs):
        if isinstance(key, str):
            return kwargs.get(key, '<' + key + '>')
        return Formatter.get_value(self, key, args, kwargs)

    def check_unused_args(self, used_args, args, kwargs):
        self.used = sorted(used_args, key=str)


def render(template):
    t = Template(template)
    return (t.safe_substitute(a=1), t.is_valid(), t.get_identifiers())


def lenient(format_string, *args, **kwargs):
    formatter = Lenient()
    return (formatter.format(format_string, *args, **kwargs), formatter.used)


order = Template('$who likes ${what}s, $$5 $who')
formatter = Formatter()


def outcome(thunk):
    try:
        return repr(thunk())
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)


def check(thunk, expected):
    actual = outcome(thunk)
    if actual != expected:
        raise AssertionError('expected ' + expected + ' but got ' + actual)


check(lambda: capwords('hello wORLD  x'), "'Hello World X'")
check(lambda: capwords('  a\tb\n'), "'A B'")
check(lambda: capwords('a-b-c', '-'), "'A-B-C'")
check(lambda: capwords(''), "''")
check(lambda: capwords('a b', sep=''), 'ValueError: empty separator')
check(lambda: capwords(3), "AttributeError: 'int' object has no attribute 'split'")
check(lambda: order.substitute(who='tim', what='kung pao'), "'tim likes kung paos, $5 tim'")
check(lambda: (order.template, order.delimiter, order.get_identifiers(), order.is_valid()), "('$who likes ${what}s, $$5 $who', '$', ['who', 'what'], True)")
check(lambda: order.substitute({'who': 'a', 'what': 1}), "'a likes 1s, $5 a'")
check(lambda: order.substitute({'who': 'a'}, what=2), "'a likes 2s, $5 a'")
check(lambda: order.substitute({'who': 'a', 'what': 1}, who='b'), "'b likes 1s, $5 b'")
check(lambda: order.safe_substitute(), "'$who likes ${what}s, $5 $who'")
check(lambda: order.safe_substitute(who=3), "'3 likes ${what}s, $5 3'")
check(lambda: order.substitute(who='x'), "KeyError: 'what'")
check(lambda: Template('$x').substitute(), "KeyError: 'x'")
check(lambda: Template('a $ b').substitute(), 'ValueError: Invalid placeholder in string: line 1, col 3')
check(lambda: Template('line\n\n ab $').substitute(), 'ValueError: Invalid placeholder in string: line 3, col 5')
check(lambda: Template('a\r\nb ${ c').substitute(), 'ValueError: Invalid placeholder in string: line 2, col 3')
check(lambda: Template('${a b}').substitute(a=1), 'ValueError: Invalid placeholder in string: line 1, col 1')
check(lambda: Template('$1').substitute(), 'ValueError: Invalid placeholder in string: line 1, col 1')
check(lambda: Template('$$$$').substitute(), "'$$'")
check(lambda: Template('$_a1 x $A_b').substitute(_a1=0, A_b='q'), "'0 x q'")
check(lambda: Template('$a.b ${a}${b}$c').substitute(a=1, b=2, c=3), "'1.b 123'")
check(lambda: Template('$a $self $mapping').substitute(a=1, self=2, mapping=3), "'1 2 3'")
check(lambda: render('$'), "('$', False, [])")
check(lambda: render('${'), "('${', False, [])")
check(lambda: render('${a'), "('${a', False, [])")
check(lambda: render('${a}}'), "('1}', True, ['a'])")
check(lambda: render('x${}y'), "('x${}y', False, [])")
check(lambda: render('$a$b ${a}'), "('1$b 1', True, ['a', 'b'])")
check(lambda: render(''), "('', True, [])")
check(lambda: Percent('%a %% $a %{b} %').safe_substitute(a=1, b=2), "'1 % $a 2 %'")
check(lambda: (Percent('%a %{b}').get_identifiers(), Percent('% a').is_valid()), "(['a', 'b'], False)")
check(lambda: Tag('<<a <<<<b <<<a << <').safe_substitute(a=1, b=2), "'1 <<b <<<a << <'")
check(lambda: Template(), "TypeError: Template.__init__() missing 1 required positional argument: 'template'")
check(lambda: Template('a').substitute(1, 2), 'TypeError: Template.substitute() takes from 1 to 2 positional arguments but 3 were given')
check(lambda: Template(3).substitute(), "TypeError: expected string or bytes-like object, got 'int'")
check(lambda: Template('$a').substitute(3), "TypeError: 'int' object is not subscriptable")
check(lambda: (Template, Formatter, capwords.__name__), "(<class 'string.Template'>, <class 'string.Formatter'>, 'capwords')")
check(lambda: formatter.format('{} {} {a!r:>5}', 1, 2, a='x'), '"1 2   \'x\'"')
check(lambda: formatter.format('{0:{1}} {x.real} {y[0]} {y[k]}', 3, 5, x=4, y={0: 'z', 'k': 'K'}), "'    3 4 z K'")
check(lambda: list(formatter.parse('a{0!r:>{w}}b{{c}}{x.y[1]}d')), "[('a', '0', '>{w}', 'r'), ('b{', None, None, None), ('c}', None, None, None), ('', 'x.y[1]', '', None), ('d', None, None, None)]")
check(lambda: (list(formatter.parse('')), list(formatter.parse('{}')), list(formatter.parse('}}{{'))), "([], [('', '', '', None)], [('}', None, None, None), ('{', None, None, None)])")
check(lambda: formatter.vformat('{a}-{0}', (1,), {'a': 2}), "'2-1'")
check(lambda: (formatter.get_field('0.real', (5,), {}), formatter.get_value('k', (), {'k': 3})), '((5, 0), 3)')
check(lambda: (formatter.convert_field(1, 'r'), formatter.convert_field('é', 'a'), formatter.format_field(3, '03d')), '(\'1\', "\'\\\\xe9\'", \'003\')')
check(lambda: formatter.convert_field(1, 'z'), 'ValueError: Unknown conversion specifier z')
check(lambda: formatter.format('{'), "ValueError: Single '{' encountered in format string")
check(lambda: formatter.format('}'), "ValueError: Single '}' encountered in format string")
check(lambda: formatter.format('{a', a=1), "ValueError: expected '}' before end of string")
check(lambda: formatter.format('{a!', a=1), 'ValueError: end of string while looking for conversion specifier')
check(lambda: formatter.format('{a!rx}', a=1), "ValueError: expected ':' after conversion specifier")
check(lambda: formatter.format('{a:{', a=1), "ValueError: unmatched '{' in format spec")
check(lambda: formatter.format('{a{b}}', a=1), "ValueError: unexpected '{' in field name")
check(lambda: formatter.format('{a[}', a=1), "ValueError: expected '}' before end of string")
check(lambda: formatter.format('{0} {}', 1), 'ValueError: cannot switch from manual field specification to automatic field numbering')
check(lambda: formatter.format('{} {0}', 1), 'ValueError: cannot switch from automatic field numbering to manual field specification')
check(lambda: formatter.format('{a.}', a=1), 'ValueError: Empty attribute in format string')
check(lambda: formatter.format('{a[]}', a=1), 'ValueError: Empty attribute in format string')
check(lambda: formatter.format('{a[0]x}', a=[1]), "ValueError: Only '.' or '[' may follow ']' in format field specifier")
check(lambda: formatter.format('{a[0]x}', a=1), "TypeError: 'int' object is not subscriptable")
check(lambda: formatter.format('{:{:{:{}}}}', 1, 2, 3, 4), 'ValueError: Max string recursion exceeded')
check(lambda: formatter.format('{b}', a=1), "KeyError: 'b'")
check(lambda: formatter.format('{5}', 1), 'IndexError: tuple index out of range')
check(lambda: formatter.format('{b} {', a=1), "KeyError: 'b'")
check(lambda: formatter.format(), "TypeError: Formatter.format() missing 1 required positional argument: 'format_string'")
check(lambda: lenient('{a} {b} {0}', 9, a=1), "('1 <b> 9', [0, 'a', 'b'])")
check(lambda: (string.ascii_lowercase, string.digits, string.punctuation), '(\'abcdefghijklmnopqrstuvwxyz\', \'0123456789\', \'!"#$%&\\\'()*+,-./:;<=>?@[\\\\]^_`{|}~\')')
check(lambda: sorted(name for name in dir(string) if not name.startswith('_')), "['Formatter', 'Template', 'ascii_letters', 'ascii_lowercase', 'ascii_uppercase', 'capwords', 'digits', 'hexdigits', 'octdigits', 'printable', 'punctuation', 'whitespace']")
