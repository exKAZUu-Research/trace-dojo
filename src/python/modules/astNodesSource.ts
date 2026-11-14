// The node classes of CPython 3.14's C module `_ast`, written in Python, with their fields, attributes, docstrings, and
// constructors.
export const AST_NODES_SOURCE =
  String.raw`import warnings as _warnings

PyCF_ONLY_AST = 1024
PyCF_TYPE_COMMENTS = 4096
PyCF_ALLOW_TOP_LEVEL_AWAIT = 8192
PyCF_OPTIMIZED_AST = 33792


class AST:
    _fields = ()
    _attributes = ()
    __match_args__ = ()

    def __init__(self, *args, **kwargs):
        cls = type(self)
        name = cls.__name__
        fields = cls._fields
        if len(args) > len(fields):
            raise TypeError(f"{name} constructor takes at most {len(fields)} positional "
                            f"argument{'' if len(fields) == 1 else 's'}")
        for field, value in zip(fields, args):
            setattr(self, field, value)
        for key, value in kwargs.items():
            if key in fields[:len(args)]:
                raise TypeError(f"{name} got multiple values for argument '{key}'")
            if key not in fields and key not in cls._attributes:
                _warnings.warn(f"{name}.__init__ got an unexpected keyword argument '{key}'. Support for "
                               f"arbitrary keyword arguments is deprecated and will be removed in Python 3.15.",
                               DeprecationWarning, stacklevel=2)
            setattr(self, key, value)
        kinds = _field_kinds(cls)
        for field in fields:
            if field in self.__dict__:
                continue
            kind = kinds.get(field, 'required')
            if kind == 'list':
                setattr(self, field, [])
            elif kind == 'optional':
                setattr(self, field, None)
            elif kind == 'ctx':
                setattr(self, field, Load())
            else:
                _warnings.warn(f"{name}.__init__ missing 1 required positional argument: '{field}'. This will "
                               f"become an error in Python 3.15.", DeprecationWarning, stacklevel=2)

    def __reduce__(self):
        return type(self), (), self.__dict__ or None

    def __replace__(self, **kwargs):
        cls = type(self)
        for key in kwargs:
            if key not in cls._fields and key not in cls._attributes:
                raise TypeError(f"{cls.__name__}.__replace__ got an unexpected keyword argument '{key}'.")
        fields = {}
        for field in cls._fields + cls._attributes:
            if field in kwargs:
                fields[field] = kwargs[field]
            elif field in self.__dict__:
                fields[field] = self.__dict__[field]
        missing = [field for field in cls._fields if field not in fields
                   and _field_kinds(cls).get(field, 'required') == 'required']
        if missing:
            names = ', '.join(repr(field) for field in missing)
            raise TypeError(f"{cls.__name__}.__replace__ missing {len(missing)} keyword argument"
                            f"{'' if len(missing) == 1 else 's'}: {names}.")
        return cls(**fields)

    def __repr__(self):
        return _repr(self, 3)


def _field_kinds(cls):
    for base in cls.__mro__:
        kinds = _FIELD_KINDS.get(base)
        if kinds is not None:
            return kinds
    return {}


def _repr(node, depth):
    name = type(node).__name__
    if depth <= 0:
        return f'{name}(...)'
    parts = []
    for field in type(node)._fields:
        value = getattr(node, field)
        if isinstance(value, (list, tuple)):
            text = _repr_sequence(value, depth)
        elif isinstance(value, AST):
            text = _repr(value, depth - 1)
        else:
            text = repr(value)
        parts.append(f'{field}={text}')
    return f"{name}({', '.join(parts)})"


def _repr_sequence(items, depth):
    if not items:
        return repr(items)
    def item_repr(item):
        return _repr(item, depth - 1) if isinstance(item, AST) else repr(item)
    if len(items) <= 2:
        texts = [item_repr(item) for item in items]
    else:
        texts = [item_repr(items[0]), '...', item_repr(items[-1])]
    inner = ', '.join(texts)
    return f'[{inner}]' if isinstance(items, list) else f'({inner})'


# The node classes of CPython 3.14's ` +
  '`' +
  String.raw`_ast` +
  '`' +
  String.raw` module, with their fields, attributes, and docstrings.

class operator(AST):
    __doc__ = 'operator = Add | Sub | Mult | MatMult | Div | Mod | Pow | LShift | RShift | BitOr | BitXor | BitAnd | FloorDiv'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class Add(operator):
    __doc__ = 'Add'
    _fields = ()
    __match_args__ = ()


class boolop(AST):
    __doc__ = 'boolop = And | Or'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class And(boolop):
    __doc__ = 'And'
    _fields = ()
    __match_args__ = ()


class stmt(AST):
    __doc__ = 'stmt = FunctionDef(identifier name, arguments args, stmt* body, expr* decorator_list, expr? returns, string? type_comment, type_param* type_params)\n     | AsyncFunctionDef(identifier name, arguments args, stmt* body, expr* decorator_list, expr? returns, string? type_comment, type_param* type_params)\n     | ClassDef(identifier name, expr* bases, keyword* keywords, stmt* body, expr* decorator_list, type_param* type_params)\n     | Return(expr? value)\n     | Delete(expr* targets)\n     | Assign(expr* targets, expr value, string? type_comment)\n     | TypeAlias(expr name, type_param* type_params, expr value)\n     | AugAssign(expr target, operator op, expr value)\n     | AnnAssign(expr target, expr annotation, expr? value, int simple)\n     | For(expr target, expr iter, stmt* body, stmt* orelse, string? type_comment)\n     | AsyncFor(expr target, expr iter, stmt* body, stmt* orelse, string? type_comment)\n     | While(expr test, stmt* body, stmt* orelse)\n     | If(expr test, stmt* body, stmt* orelse)\n     | With(withitem* items, stmt* body, string? type_comment)\n     | AsyncWith(withitem* items, stmt* body, string? type_comment)\n     | Match(expr subject, match_case* cases)\n     | Raise(expr? exc, expr? cause)\n     | Try(stmt* body, excepthandler* handlers, stmt* orelse, stmt* finalbody)\n     | TryStar(stmt* body, excepthandler* handlers, stmt* orelse, stmt* finalbody)\n     | Assert(expr test, expr? msg)\n     | Import(alias* names)\n     | ImportFrom(identifier? module, alias* names, int? level)\n     | Global(identifier* names)\n     | Nonlocal(identifier* names)\n     | Expr(expr value)\n     | Pass\n     | Break\n     | Continue'
    _fields = ()
    __match_args__ = ()
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class AnnAssign(stmt):
    __doc__ = 'AnnAssign(expr target, expr annotation, expr? value, int simple)'
    _fields = ('target', 'annotation', 'value', 'simple')
    __match_args__ = ('target', 'annotation', 'value', 'simple')


class Assert(stmt):
    __doc__ = 'Assert(expr test, expr? msg)'
    _fields = ('test', 'msg')
    __match_args__ = ('test', 'msg')


class Assign(stmt):
    __doc__ = 'Assign(expr* targets, expr value, string? type_comment)'
    _fields = ('targets', 'value', 'type_comment')
    __match_args__ = ('targets', 'value', 'type_comment')


class AsyncFor(stmt):
    __doc__ = 'AsyncFor(expr target, expr iter, stmt* body, stmt* orelse, string? type_comment)'
    _fields = ('target', 'iter', 'body', 'orelse', 'type_comment')
    __match_args__ = ('target', 'iter', 'body', 'orelse', 'type_comment')


class AsyncFunctionDef(stmt):
    __doc__ = 'AsyncFunctionDef(identifier name, arguments args, stmt* body, expr* decorator_list, expr? returns, string? type_comment, type_param* type_params)'
    _fields = ('name', 'args', 'body', 'decorator_list', 'returns', 'type_comment', 'type_params')
    __match_args__ = ('name', 'args', 'body', 'decorator_list', 'returns', 'type_comment', 'type_params')


class AsyncWith(stmt):
    __doc__ = 'AsyncWith(withitem* items, stmt* body, string? type_comment)'
    _fields = ('items', 'body', 'type_comment')
    __match_args__ = ('items', 'body', 'type_comment')


class expr(AST):
    __doc__ = 'expr = BoolOp(boolop op, expr* values)\n     | NamedExpr(expr target, expr value)\n     | BinOp(expr left, operator op, expr right)\n     | UnaryOp(unaryop op, expr operand)\n     | Lambda(arguments args, expr body)\n     | IfExp(expr test, expr body, expr orelse)\n     | Dict(expr?* keys, expr* values)\n     | Set(expr* elts)\n     | ListComp(expr elt, comprehension* generators)\n     | SetComp(expr elt, comprehension* generators)\n     | DictComp(expr key, expr value, comprehension* generators)\n     | GeneratorExp(expr elt, comprehension* generators)\n     | Await(expr value)\n     | Yield(expr? value)\n     | YieldFrom(expr value)\n     | Compare(expr left, cmpop* ops, expr* comparators)\n     | Call(expr func, expr* args, keyword* keywords)\n     | FormattedValue(expr value, int conversion, expr? format_spec)\n     | Interpolation(expr value, constant str, int conversion, expr? format_spec)\n     | JoinedStr(expr* values)\n     | TemplateStr(expr* values)\n     | Constant(constant value, string? kind)\n     | Attribute(expr value, identifier attr, expr_context ctx)\n     | Subscript(expr value, expr slice, expr_context ctx)\n     | Starred(expr value, expr_context ctx)\n     | Name(identifier id, expr_context ctx)\n     | List(expr* elts, expr_context ctx)\n     | Tuple(expr* elts, expr_context ctx)\n     | Slice(expr? lower, expr? upper, expr? step)'
    _fields = ()
    __match_args__ = ()
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class Attribute(expr):
    __doc__ = 'Attribute(expr value, identifier attr, expr_context ctx)'
    _fields = ('value', 'attr', 'ctx')
    __match_args__ = ('value', 'attr', 'ctx')


class AugAssign(stmt):
    __doc__ = 'AugAssign(expr target, operator op, expr value)'
    _fields = ('target', 'op', 'value')
    __match_args__ = ('target', 'op', 'value')


class Await(expr):
    __doc__ = 'Await(expr value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class BinOp(expr):
    __doc__ = 'BinOp(expr left, operator op, expr right)'
    _fields = ('left', 'op', 'right')
    __match_args__ = ('left', 'op', 'right')


class BitAnd(operator):
    __doc__ = 'BitAnd'
    _fields = ()
    __match_args__ = ()


class BitOr(operator):
    __doc__ = 'BitOr'
    _fields = ()
    __match_args__ = ()


class BitXor(operator):
    __doc__ = 'BitXor'
    _fields = ()
    __match_args__ = ()


class BoolOp(expr):
    __doc__ = 'BoolOp(boolop op, expr* values)'
    _fields = ('op', 'values')
    __match_args__ = ('op', 'values')


class Break(stmt):
    __doc__ = 'Break'
    _fields = ()
    __match_args__ = ()


class Call(expr):
    __doc__ = 'Call(expr func, expr* args, keyword* keywords)'
    _fields = ('func', 'args', 'keywords')
    __match_args__ = ('func', 'args', 'keywords')


class ClassDef(stmt):
    __doc__ = 'ClassDef(identifier name, expr* bases, keyword* keywords, stmt* body, expr* decorator_list, type_param* type_params)'
    _fields = ('name', 'bases', 'keywords', 'body', 'decorator_list', 'type_params')
    __match_args__ = ('name', 'bases', 'keywords', 'body', 'decorator_list', 'type_params')


class Compare(expr):
    __doc__ = 'Compare(expr left, cmpop* ops, expr* comparators)'
    _fields = ('left', 'ops', 'comparators')
    __match_args__ = ('left', 'ops', 'comparators')


class Constant(expr):
    __doc__ = 'Constant(constant value, string? kind)'
    _fields = ('value', 'kind')
    __match_args__ = ('value', 'kind')


class Continue(stmt):
    __doc__ = 'Continue'
    _fields = ()
    __match_args__ = ()


class expr_context(AST):
    __doc__ = 'expr_context = Load | Store | Del'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class Del(expr_context):
    __doc__ = 'Del'
    _fields = ()
    __match_args__ = ()


class Delete(stmt):
    __doc__ = 'Delete(expr* targets)'
    _fields = ('targets',)
    __match_args__ = ('targets',)


class Dict(expr):
    __doc__ = 'Dict(expr?* keys, expr* values)'
    _fields = ('keys', 'values')
    __match_args__ = ('keys', 'values')


class DictComp(expr):
    __doc__ = 'DictComp(expr key, expr value, comprehension* generators)'
    _fields = ('key', 'value', 'generators')
    __match_args__ = ('key', 'value', 'generators')


class Div(operator):
    __doc__ = 'Div'
    _fields = ()
    __match_args__ = ()


class cmpop(AST):
    __doc__ = 'cmpop = Eq | NotEq | Lt | LtE | Gt | GtE | Is | IsNot | In | NotIn'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class Eq(cmpop):
    __doc__ = 'Eq'
    _fields = ()
    __match_args__ = ()


class excepthandler(AST):
    __doc__ = 'excepthandler = ExceptHandler(expr? type, identifier? name, stmt* body)'
    _fields = ()
    __match_args__ = ()
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class ExceptHandler(excepthandler):
    __doc__ = 'ExceptHandler(expr? type, identifier? name, stmt* body)'
    _fields = ('type', 'name', 'body')
    __match_args__ = ('type', 'name', 'body')


class Expr(stmt):
    __doc__ = 'Expr(expr value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class mod(AST):
    __doc__ = 'mod = Module(stmt* body, type_ignore* type_ignores)\n    | Interactive(stmt* body)\n    | Expression(expr body)\n    | FunctionType(expr* argtypes, expr returns)'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class Expression(mod):
    __doc__ = 'Expression(expr body)'
    _fields = ('body',)
    __match_args__ = ('body',)


class FloorDiv(operator):
    __doc__ = 'FloorDiv'
    _fields = ()
    __match_args__ = ()


class For(stmt):
    __doc__ = 'For(expr target, expr iter, stmt* body, stmt* orelse, string? type_comment)'
    _fields = ('target', 'iter', 'body', 'orelse', 'type_comment')
    __match_args__ = ('target', 'iter', 'body', 'orelse', 'type_comment')


class FormattedValue(expr):
    __doc__ = 'FormattedValue(expr value, int conversion, expr? format_spec)'
    _fields = ('value', 'conversion', 'format_spec')
    __match_args__ = ('value', 'conversion', 'format_spec')


class FunctionDef(stmt):
    __doc__ = 'FunctionDef(identifier name, arguments args, stmt* body, expr* decorator_list, expr? returns, string? type_comment, type_param* type_params)'
    _fields = ('name', 'args', 'body', 'decorator_list', 'returns', 'type_comment', 'type_params')
    __match_args__ = ('name', 'args', 'body', 'decorator_list', 'returns', 'type_comment', 'type_params')


class FunctionType(mod):
    __doc__ = 'FunctionType(expr* argtypes, expr returns)'
    _fields = ('argtypes', 'returns')
    __match_args__ = ('argtypes', 'returns')


class GeneratorExp(expr):
    __doc__ = 'GeneratorExp(expr elt, comprehension* generators)'
    _fields = ('elt', 'generators')
    __match_args__ = ('elt', 'generators')


class Global(stmt):
    __doc__ = 'Global(identifier* names)'
    _fields = ('names',)
    __match_args__ = ('names',)


class Gt(cmpop):
    __doc__ = 'Gt'
    _fields = ()
    __match_args__ = ()


class GtE(cmpop):
    __doc__ = 'GtE'
    _fields = ()
    __match_args__ = ()


class If(stmt):
    __doc__ = 'If(expr test, stmt* body, stmt* orelse)'
    _fields = ('test', 'body', 'orelse')
    __match_args__ = ('test', 'body', 'orelse')


class IfExp(expr):
    __doc__ = 'IfExp(expr test, expr body, expr orelse)'
    _fields = ('test', 'body', 'orelse')
    __match_args__ = ('test', 'body', 'orelse')


class Import(stmt):
    __doc__ = 'Import(alias* names)'
    _fields = ('names',)
    __match_args__ = ('names',)


class ImportFrom(stmt):
    __doc__ = 'ImportFrom(identifier? module, alias* names, int? level)'
    _fields = ('module', 'names', 'level')
    __match_args__ = ('module', 'names', 'level')


class In(cmpop):
    __doc__ = 'In'
    _fields = ()
    __match_args__ = ()


class Interactive(mod):
    __doc__ = 'Interactive(stmt* body)'
    _fields = ('body',)
    __match_args__ = ('body',)


class Interpolation(expr):
    __doc__ = 'Interpolation(expr value, constant str, int conversion, expr? format_spec)'
    _fields = ('value', 'str', 'conversion', 'format_spec')
    __match_args__ = ('value', 'str', 'conversion', 'format_spec')


class unaryop(AST):
    __doc__ = 'unaryop = Invert | Not | UAdd | USub'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class Invert(unaryop):
    __doc__ = 'Invert'
    _fields = ()
    __match_args__ = ()


class Is(cmpop):
    __doc__ = 'Is'
    _fields = ()
    __match_args__ = ()


class IsNot(cmpop):
    __doc__ = 'IsNot'
    _fields = ()
    __match_args__ = ()


class JoinedStr(expr):
    __doc__ = 'JoinedStr(expr* values)'
    _fields = ('values',)
    __match_args__ = ('values',)


class LShift(operator):
    __doc__ = 'LShift'
    _fields = ()
    __match_args__ = ()


class Lambda(expr):
    __doc__ = 'Lambda(arguments args, expr body)'
    _fields = ('args', 'body')
    __match_args__ = ('args', 'body')


class List(expr):
    __doc__ = 'List(expr* elts, expr_context ctx)'
    _fields = ('elts', 'ctx')
    __match_args__ = ('elts', 'ctx')


class ListComp(expr):
    __doc__ = 'ListComp(expr elt, comprehension* generators)'
    _fields = ('elt', 'generators')
    __match_args__ = ('elt', 'generators')


class Load(expr_context):
    __doc__ = 'Load'
    _fields = ()
    __match_args__ = ()


class Lt(cmpop):
    __doc__ = 'Lt'
    _fields = ()
    __match_args__ = ()


class LtE(cmpop):
    __doc__ = 'LtE'
    _fields = ()
    __match_args__ = ()


class MatMult(operator):
    __doc__ = 'MatMult'
    _fields = ()
    __match_args__ = ()


class Match(stmt):
    __doc__ = 'Match(expr subject, match_case* cases)'
    _fields = ('subject', 'cases')
    __match_args__ = ('subject', 'cases')


class pattern(AST):
    __doc__ = 'pattern = MatchValue(expr value)\n        | MatchSingleton(constant value)\n        | MatchSequence(pattern* patterns)\n        | MatchMapping(expr* keys, pattern* patterns, identifier? rest)\n        | MatchClass(expr cls, pattern* patterns, identifier* kwd_attrs, pattern* kwd_patterns)\n        | MatchStar(identifier? name)\n        | MatchAs(pattern? pattern, identifier? name)\n        | MatchOr(pattern* patterns)'
    _fields = ()
    __match_args__ = ()
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class MatchAs(pattern):
    __doc__ = 'MatchAs(pattern? pattern, identifier? name)'
    _fields = ('pattern', 'name')
    __match_args__ = ('pattern', 'name')


class MatchClass(pattern):
    __doc__ = 'MatchClass(expr cls, pattern* patterns, identifier* kwd_attrs, pattern* kwd_patterns)'
    _fields = ('cls', 'patterns', 'kwd_attrs', 'kwd_patterns')
    __match_args__ = ('cls', 'patterns', 'kwd_attrs', 'kwd_patterns')


class MatchMapping(pattern):
    __doc__ = 'MatchMapping(expr* keys, pattern* patterns, identifier? rest)'
    _fields = ('keys', 'patterns', 'rest')
    __match_args__ = ('keys', 'patterns', 'rest')


class MatchOr(pattern):
    __doc__ = 'MatchOr(pattern* patterns)'
    _fields = ('patterns',)
    __match_args__ = ('patterns',)


class MatchSequence(pattern):
    __doc__ = 'MatchSequence(pattern* patterns)'
    _fields = ('patterns',)
    __match_args__ = ('patterns',)


class MatchSingleton(pattern):
    __doc__ = 'MatchSingleton(constant value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class MatchStar(pattern):
    __doc__ = 'MatchStar(identifier? name)'
    _fields = ('name',)
    __match_args__ = ('name',)


class MatchValue(pattern):
    __doc__ = 'MatchValue(expr value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class Mod(operator):
    __doc__ = 'Mod'
    _fields = ()
    __match_args__ = ()


class Module(mod):
    __doc__ = 'Module(stmt* body, type_ignore* type_ignores)'
    _fields = ('body', 'type_ignores')
    __match_args__ = ('body', 'type_ignores')


class Mult(operator):
    __doc__ = 'Mult'
    _fields = ()
    __match_args__ = ()


class Name(expr):
    __doc__ = 'Name(identifier id, expr_context ctx)'
    _fields = ('id', 'ctx')
    __match_args__ = ('id', 'ctx')


class NamedExpr(expr):
    __doc__ = 'NamedExpr(expr target, expr value)'
    _fields = ('target', 'value')
    __match_args__ = ('target', 'value')


class Nonlocal(stmt):
    __doc__ = 'Nonlocal(identifier* names)'
    _fields = ('names',)
    __match_args__ = ('names',)


class Not(unaryop):
    __doc__ = 'Not'
    _fields = ()
    __match_args__ = ()


class NotEq(cmpop):
    __doc__ = 'NotEq'
    _fields = ()
    __match_args__ = ()


class NotIn(cmpop):
    __doc__ = 'NotIn'
    _fields = ()
    __match_args__ = ()


class Or(boolop):
    __doc__ = 'Or'
    _fields = ()
    __match_args__ = ()


class type_param(AST):
    __doc__ = 'type_param = TypeVar(identifier name, expr? bound, expr? default_value)\n           | ParamSpec(identifier name, expr? default_value)\n           | TypeVarTuple(identifier name, expr? default_value)'
    _fields = ()
    __match_args__ = ()
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class ParamSpec(type_param):
    __doc__ = 'ParamSpec(identifier name, expr? default_value)'
    _fields = ('name', 'default_value')
    __match_args__ = ('name', 'default_value')


class Pass(stmt):
    __doc__ = 'Pass'
    _fields = ()
    __match_args__ = ()


class Pow(operator):
    __doc__ = 'Pow'
    _fields = ()
    __match_args__ = ()


class RShift(operator):
    __doc__ = 'RShift'
    _fields = ()
    __match_args__ = ()


class Raise(stmt):
    __doc__ = 'Raise(expr? exc, expr? cause)'
    _fields = ('exc', 'cause')
    __match_args__ = ('exc', 'cause')


class Return(stmt):
    __doc__ = 'Return(expr? value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class Set(expr):
    __doc__ = 'Set(expr* elts)'
    _fields = ('elts',)
    __match_args__ = ('elts',)


class SetComp(expr):
    __doc__ = 'SetComp(expr elt, comprehension* generators)'
    _fields = ('elt', 'generators')
    __match_args__ = ('elt', 'generators')


class Slice(expr):
    __doc__ = 'Slice(expr? lower, expr? upper, expr? step)'
    _fields = ('lower', 'upper', 'step')
    __match_args__ = ('lower', 'upper', 'step')


class Starred(expr):
    __doc__ = 'Starred(expr value, expr_context ctx)'
    _fields = ('value', 'ctx')
    __match_args__ = ('value', 'ctx')


class Store(expr_context):
    __doc__ = 'Store'
    _fields = ()
    __match_args__ = ()


class Sub(operator):
    __doc__ = 'Sub'
    _fields = ()
    __match_args__ = ()


class Subscript(expr):
    __doc__ = 'Subscript(expr value, expr slice, expr_context ctx)'
    _fields = ('value', 'slice', 'ctx')
    __match_args__ = ('value', 'slice', 'ctx')


class TemplateStr(expr):
    __doc__ = 'TemplateStr(expr* values)'
    _fields = ('values',)
    __match_args__ = ('values',)


class Try(stmt):
    __doc__ = 'Try(stmt* body, excepthandler* handlers, stmt* orelse, stmt* finalbody)'
    _fields = ('body', 'handlers', 'orelse', 'finalbody')
    __match_args__ = ('body', 'handlers', 'orelse', 'finalbody')


class TryStar(stmt):
    __doc__ = 'TryStar(stmt* body, excepthandler* handlers, stmt* orelse, stmt* finalbody)'
    _fields = ('body', 'handlers', 'orelse', 'finalbody')
    __match_args__ = ('body', 'handlers', 'orelse', 'finalbody')


class Tuple(expr):
    __doc__ = 'Tuple(expr* elts, expr_context ctx)'
    _fields = ('elts', 'ctx')
    __match_args__ = ('elts', 'ctx')


class TypeAlias(stmt):
    __doc__ = 'TypeAlias(expr name, type_param* type_params, expr value)'
    _fields = ('name', 'type_params', 'value')
    __match_args__ = ('name', 'type_params', 'value')


class type_ignore(AST):
    __doc__ = 'type_ignore = TypeIgnore(int lineno, string tag)'
    _fields = ()
    __match_args__ = ()
    _attributes = ()


class TypeIgnore(type_ignore):
    __doc__ = 'TypeIgnore(int lineno, string tag)'
    _fields = ('lineno', 'tag')
    __match_args__ = ('lineno', 'tag')


class TypeVar(type_param):
    __doc__ = 'TypeVar(identifier name, expr? bound, expr? default_value)'
    _fields = ('name', 'bound', 'default_value')
    __match_args__ = ('name', 'bound', 'default_value')


class TypeVarTuple(type_param):
    __doc__ = 'TypeVarTuple(identifier name, expr? default_value)'
    _fields = ('name', 'default_value')
    __match_args__ = ('name', 'default_value')


class UAdd(unaryop):
    __doc__ = 'UAdd'
    _fields = ()
    __match_args__ = ()


class USub(unaryop):
    __doc__ = 'USub'
    _fields = ()
    __match_args__ = ()


class UnaryOp(expr):
    __doc__ = 'UnaryOp(unaryop op, expr operand)'
    _fields = ('op', 'operand')
    __match_args__ = ('op', 'operand')


class While(stmt):
    __doc__ = 'While(expr test, stmt* body, stmt* orelse)'
    _fields = ('test', 'body', 'orelse')
    __match_args__ = ('test', 'body', 'orelse')


class With(stmt):
    __doc__ = 'With(withitem* items, stmt* body, string? type_comment)'
    _fields = ('items', 'body', 'type_comment')
    __match_args__ = ('items', 'body', 'type_comment')


class Yield(expr):
    __doc__ = 'Yield(expr? value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class YieldFrom(expr):
    __doc__ = 'YieldFrom(expr value)'
    _fields = ('value',)
    __match_args__ = ('value',)


class alias(AST):
    __doc__ = 'alias(identifier name, identifier? asname)'
    _fields = ('name', 'asname')
    __match_args__ = ('name', 'asname')
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class arg(AST):
    __doc__ = 'arg(identifier arg, expr? annotation, string? type_comment)'
    _fields = ('arg', 'annotation', 'type_comment')
    __match_args__ = ('arg', 'annotation', 'type_comment')
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class arguments(AST):
    __doc__ = 'arguments(arg* posonlyargs, arg* args, arg? vararg, arg* kwonlyargs, expr?* kw_defaults, arg? kwarg, expr* defaults)'
    _fields = ('posonlyargs', 'args', 'vararg', 'kwonlyargs', 'kw_defaults', 'kwarg', 'defaults')
    __match_args__ = ('posonlyargs', 'args', 'vararg', 'kwonlyargs', 'kw_defaults', 'kwarg', 'defaults')
    _attributes = ()


class comprehension(AST):
    __doc__ = 'comprehension(expr target, expr iter, expr* ifs, int is_async)'
    _fields = ('target', 'iter', 'ifs', 'is_async')
    __match_args__ = ('target', 'iter', 'ifs', 'is_async')
    _attributes = ()


class keyword(AST):
    __doc__ = 'keyword(identifier? arg, expr value)'
    _fields = ('arg', 'value')
    __match_args__ = ('arg', 'value')
    _attributes = ('lineno', 'col_offset', 'end_lineno', 'end_col_offset')


class match_case(AST):
    __doc__ = 'match_case(pattern pattern, expr? guard, stmt* body)'
    _fields = ('pattern', 'guard', 'body')
    __match_args__ = ('pattern', 'guard', 'body')
    _attributes = ()


class withitem(AST):
    __doc__ = 'withitem(expr context_expr, expr? optional_vars)'
    _fields = ('context_expr', 'optional_vars')
    __match_args__ = ('context_expr', 'optional_vars')
    _attributes = ()


_classes = (AST, operator, Add, boolop, And, stmt, AnnAssign, Assert, Assign, AsyncFor, AsyncFunctionDef, AsyncWith, expr, Attribute, AugAssign, Await, BinOp, BitAnd, BitOr, BitXor, BoolOp, Break, Call, ClassDef, Compare, Constant, Continue, expr_context, Del, Delete, Dict, DictComp, Div, cmpop, Eq, excepthandler, ExceptHandler, Expr, mod, Expression, FloorDiv, For, FormattedValue, FunctionDef, FunctionType, GeneratorExp, Global, Gt, GtE, If, IfExp, Import, ImportFrom, In, Interactive, Interpolation, unaryop, Invert, Is, IsNot, JoinedStr, LShift, Lambda, List, ListComp, Load, Lt, LtE, MatMult, Match, pattern, MatchAs, MatchClass, MatchMapping, MatchOr, MatchSequence, MatchSingleton, MatchStar, MatchValue, Mod, Module, Mult, Name, NamedExpr, Nonlocal, Not, NotEq, NotIn, Or, type_param, ParamSpec, Pass, Pow, RShift, Raise, Return, Set, SetComp, Slice, Starred, Store, Sub, Subscript, TemplateStr, Try, TryStar, Tuple, TypeAlias, type_ignore, TypeIgnore, TypeVar, TypeVarTuple, UAdd, USub, UnaryOp, While, With, Yield, YieldFrom, alias, arg, arguments, comprehension, keyword, match_case, withitem)
for _cls in _classes:
    _cls.__module__ = 'ast'

Add._field_types = {}
Add.__annotations__ = Add._field_types
And._field_types = {}
And.__annotations__ = And._field_types
AnnAssign._field_types = {'target': expr, 'annotation': expr, 'value': expr | None, 'simple': int}
AnnAssign.__annotations__ = AnnAssign._field_types
Assert._field_types = {'test': expr, 'msg': expr | None}
Assert.__annotations__ = Assert._field_types
Assign._field_types = {'targets': list[expr], 'value': expr, 'type_comment': str | None}
Assign.__annotations__ = Assign._field_types
AsyncFor._field_types = {'target': expr, 'iter': expr, 'body': list[stmt], 'orelse': list[stmt], 'type_comment': str | None}
AsyncFor.__annotations__ = AsyncFor._field_types
AsyncFunctionDef._field_types = {'name': str, 'args': arguments, 'body': list[stmt], 'decorator_list': list[expr], 'returns': expr | None, 'type_comment': str | None, 'type_params': list[type_param]}
AsyncFunctionDef.__annotations__ = AsyncFunctionDef._field_types
AsyncWith._field_types = {'items': list[withitem], 'body': list[stmt], 'type_comment': str | None}
AsyncWith.__annotations__ = AsyncWith._field_types
Attribute._field_types = {'value': expr, 'attr': str, 'ctx': expr_context}
Attribute.__annotations__ = Attribute._field_types
AugAssign._field_types = {'target': expr, 'op': operator, 'value': expr}
AugAssign.__annotations__ = AugAssign._field_types
Await._field_types = {'value': expr}
Await.__annotations__ = Await._field_types
BinOp._field_types = {'left': expr, 'op': operator, 'right': expr}
BinOp.__annotations__ = BinOp._field_types
BitAnd._field_types = {}
BitAnd.__annotations__ = BitAnd._field_types
BitOr._field_types = {}
BitOr.__annotations__ = BitOr._field_types
BitXor._field_types = {}
BitXor.__annotations__ = BitXor._field_types
BoolOp._field_types = {'op': boolop, 'values': list[expr]}
BoolOp.__annotations__ = BoolOp._field_types
Break._field_types = {}
Break.__annotations__ = Break._field_types
Call._field_types = {'func': expr, 'args': list[expr], 'keywords': list[keyword]}
Call.__annotations__ = Call._field_types
ClassDef._field_types = {'name': str, 'bases': list[expr], 'keywords': list[keyword], 'body': list[stmt], 'decorator_list': list[expr], 'type_params': list[type_param]}
ClassDef.__annotations__ = ClassDef._field_types
Compare._field_types = {'left': expr, 'ops': list[cmpop], 'comparators': list[expr]}
Compare.__annotations__ = Compare._field_types
Constant._field_types = {'value': object, 'kind': str | None}
Constant.__annotations__ = Constant._field_types
Continue._field_types = {}
Continue.__annotations__ = Continue._field_types
Del._field_types = {}
Del.__annotations__ = Del._field_types
Delete._field_types = {'targets': list[expr]}
Delete.__annotations__ = Delete._field_types
Dict._field_types = {'keys': list[expr], 'values': list[expr]}
Dict.__annotations__ = Dict._field_types
DictComp._field_types = {'key': expr, 'value': expr, 'generators': list[comprehension]}
DictComp.__annotations__ = DictComp._field_types
Div._field_types = {}
Div.__annotations__ = Div._field_types
Eq._field_types = {}
Eq.__annotations__ = Eq._field_types
ExceptHandler._field_types = {'type': expr | None, 'name': str | None, 'body': list[stmt]}
ExceptHandler.__annotations__ = ExceptHandler._field_types
Expr._field_types = {'value': expr}
Expr.__annotations__ = Expr._field_types
Expression._field_types = {'body': expr}
Expression.__annotations__ = Expression._field_types
FloorDiv._field_types = {}
FloorDiv.__annotations__ = FloorDiv._field_types
For._field_types = {'target': expr, 'iter': expr, 'body': list[stmt], 'orelse': list[stmt], 'type_comment': str | None}
For.__annotations__ = For._field_types
FormattedValue._field_types = {'value': expr, 'conversion': int, 'format_spec': expr | None}
FormattedValue.__annotations__ = FormattedValue._field_types
FunctionDef._field_types = {'name': str, 'args': arguments, 'body': list[stmt], 'decorator_list': list[expr], 'returns': expr | None, 'type_comment': str | None, 'type_params': list[type_param]}
FunctionDef.__annotations__ = FunctionDef._field_types
FunctionType._field_types = {'argtypes': list[expr], 'returns': expr}
FunctionType.__annotations__ = FunctionType._field_types
GeneratorExp._field_types = {'elt': expr, 'generators': list[comprehension]}
GeneratorExp.__annotations__ = GeneratorExp._field_types
Global._field_types = {'names': list[str]}
Global.__annotations__ = Global._field_types
Gt._field_types = {}
Gt.__annotations__ = Gt._field_types
GtE._field_types = {}
GtE.__annotations__ = GtE._field_types
If._field_types = {'test': expr, 'body': list[stmt], 'orelse': list[stmt]}
If.__annotations__ = If._field_types
IfExp._field_types = {'test': expr, 'body': expr, 'orelse': expr}
IfExp.__annotations__ = IfExp._field_types
Import._field_types = {'names': list[alias]}
Import.__annotations__ = Import._field_types
ImportFrom._field_types = {'module': str | None, 'names': list[alias], 'level': int | None}
ImportFrom.__annotations__ = ImportFrom._field_types
In._field_types = {}
In.__annotations__ = In._field_types
Interactive._field_types = {'body': list[stmt]}
Interactive.__annotations__ = Interactive._field_types
Interpolation._field_types = {'value': expr, 'str': object, 'conversion': int, 'format_spec': expr | None}
Interpolation.__annotations__ = Interpolation._field_types
Invert._field_types = {}
Invert.__annotations__ = Invert._field_types
Is._field_types = {}
Is.__annotations__ = Is._field_types
IsNot._field_types = {}
IsNot.__annotations__ = IsNot._field_types
JoinedStr._field_types = {'values': list[expr]}
JoinedStr.__annotations__ = JoinedStr._field_types
LShift._field_types = {}
LShift.__annotations__ = LShift._field_types
Lambda._field_types = {'args': arguments, 'body': expr}
Lambda.__annotations__ = Lambda._field_types
List._field_types = {'elts': list[expr], 'ctx': expr_context}
List.__annotations__ = List._field_types
ListComp._field_types = {'elt': expr, 'generators': list[comprehension]}
ListComp.__annotations__ = ListComp._field_types
Load._field_types = {}
Load.__annotations__ = Load._field_types
Lt._field_types = {}
Lt.__annotations__ = Lt._field_types
LtE._field_types = {}
LtE.__annotations__ = LtE._field_types
MatMult._field_types = {}
MatMult.__annotations__ = MatMult._field_types
Match._field_types = {'subject': expr, 'cases': list[match_case]}
Match.__annotations__ = Match._field_types
MatchAs._field_types = {'pattern': pattern | None, 'name': str | None}
MatchAs.__annotations__ = MatchAs._field_types
MatchClass._field_types = {'cls': expr, 'patterns': list[pattern], 'kwd_attrs': list[str], 'kwd_patterns': list[pattern]}
MatchClass.__annotations__ = MatchClass._field_types
MatchMapping._field_types = {'keys': list[expr], 'patterns': list[pattern], 'rest': str | None}
MatchMapping.__annotations__ = MatchMapping._field_types
MatchOr._field_types = {'patterns': list[pattern]}
MatchOr.__annotations__ = MatchOr._field_types
MatchSequence._field_types = {'patterns': list[pattern]}
MatchSequence.__annotations__ = MatchSequence._field_types
MatchSingleton._field_types = {'value': object}
MatchSingleton.__annotations__ = MatchSingleton._field_types
MatchStar._field_types = {'name': str | None}
MatchStar.__annotations__ = MatchStar._field_types
MatchValue._field_types = {'value': expr}
MatchValue.__annotations__ = MatchValue._field_types
Mod._field_types = {}
Mod.__annotations__ = Mod._field_types
Module._field_types = {'body': list[stmt], 'type_ignores': list[type_ignore]}
Module.__annotations__ = Module._field_types
Mult._field_types = {}
Mult.__annotations__ = Mult._field_types
Name._field_types = {'id': str, 'ctx': expr_context}
Name.__annotations__ = Name._field_types
NamedExpr._field_types = {'target': expr, 'value': expr}
NamedExpr.__annotations__ = NamedExpr._field_types
Nonlocal._field_types = {'names': list[str]}
Nonlocal.__annotations__ = Nonlocal._field_types
Not._field_types = {}
Not.__annotations__ = Not._field_types
NotEq._field_types = {}
NotEq.__annotations__ = NotEq._field_types
NotIn._field_types = {}
NotIn.__annotations__ = NotIn._field_types
Or._field_types = {}
Or.__annotations__ = Or._field_types
ParamSpec._field_types = {'name': str, 'default_value': expr | None}
ParamSpec.__annotations__ = ParamSpec._field_types
Pass._field_types = {}
Pass.__annotations__ = Pass._field_types
Pow._field_types = {}
Pow.__annotations__ = Pow._field_types
RShift._field_types = {}
RShift.__annotations__ = RShift._field_types
Raise._field_types = {'exc': expr | None, 'cause': expr | None}
Raise.__annotations__ = Raise._field_types
Return._field_types = {'value': expr | None}
Return.__annotations__ = Return._field_types
Set._field_types = {'elts': list[expr]}
Set.__annotations__ = Set._field_types
SetComp._field_types = {'elt': expr, 'generators': list[comprehension]}
SetComp.__annotations__ = SetComp._field_types
Slice._field_types = {'lower': expr | None, 'upper': expr | None, 'step': expr | None}
Slice.__annotations__ = Slice._field_types
Starred._field_types = {'value': expr, 'ctx': expr_context}
Starred.__annotations__ = Starred._field_types
Store._field_types = {}
Store.__annotations__ = Store._field_types
Sub._field_types = {}
Sub.__annotations__ = Sub._field_types
Subscript._field_types = {'value': expr, 'slice': expr, 'ctx': expr_context}
Subscript.__annotations__ = Subscript._field_types
TemplateStr._field_types = {'values': list[expr]}
TemplateStr.__annotations__ = TemplateStr._field_types
Try._field_types = {'body': list[stmt], 'handlers': list[excepthandler], 'orelse': list[stmt], 'finalbody': list[stmt]}
Try.__annotations__ = Try._field_types
TryStar._field_types = {'body': list[stmt], 'handlers': list[excepthandler], 'orelse': list[stmt], 'finalbody': list[stmt]}
TryStar.__annotations__ = TryStar._field_types
Tuple._field_types = {'elts': list[expr], 'ctx': expr_context}
Tuple.__annotations__ = Tuple._field_types
TypeAlias._field_types = {'name': expr, 'type_params': list[type_param], 'value': expr}
TypeAlias.__annotations__ = TypeAlias._field_types
TypeIgnore._field_types = {'lineno': int, 'tag': str}
TypeIgnore.__annotations__ = TypeIgnore._field_types
TypeVar._field_types = {'name': str, 'bound': expr | None, 'default_value': expr | None}
TypeVar.__annotations__ = TypeVar._field_types
TypeVarTuple._field_types = {'name': str, 'default_value': expr | None}
TypeVarTuple.__annotations__ = TypeVarTuple._field_types
UAdd._field_types = {}
UAdd.__annotations__ = UAdd._field_types
USub._field_types = {}
USub.__annotations__ = USub._field_types
UnaryOp._field_types = {'op': unaryop, 'operand': expr}
UnaryOp.__annotations__ = UnaryOp._field_types
While._field_types = {'test': expr, 'body': list[stmt], 'orelse': list[stmt]}
While.__annotations__ = While._field_types
With._field_types = {'items': list[withitem], 'body': list[stmt], 'type_comment': str | None}
With.__annotations__ = With._field_types
Yield._field_types = {'value': expr | None}
Yield.__annotations__ = Yield._field_types
YieldFrom._field_types = {'value': expr}
YieldFrom.__annotations__ = YieldFrom._field_types
alias._field_types = {'name': str, 'asname': str | None}
alias.__annotations__ = alias._field_types
arg._field_types = {'arg': str, 'annotation': expr | None, 'type_comment': str | None}
arg.__annotations__ = arg._field_types
arguments._field_types = {'posonlyargs': list[arg], 'args': list[arg], 'vararg': arg | None, 'kwonlyargs': list[arg], 'kw_defaults': list[expr], 'kwarg': arg | None, 'defaults': list[expr]}
arguments.__annotations__ = arguments._field_types
comprehension._field_types = {'target': expr, 'iter': expr, 'ifs': list[expr], 'is_async': int}
comprehension.__annotations__ = comprehension._field_types
keyword._field_types = {'arg': str | None, 'value': expr}
keyword.__annotations__ = keyword._field_types
match_case._field_types = {'pattern': pattern, 'guard': expr | None, 'body': list[stmt]}
match_case.__annotations__ = match_case._field_types
withitem._field_types = {'context_expr': expr, 'optional_vars': expr | None}
withitem.__annotations__ = withitem._field_types

_FIELD_KINDS = {
    Add: {},
    And: {},
    AnnAssign: {'target': 'required', 'annotation': 'required', 'value': 'optional', 'simple': 'required'},
    Assert: {'test': 'required', 'msg': 'optional'},
    Assign: {'targets': 'list', 'value': 'required', 'type_comment': 'optional'},
    AsyncFor: {'target': 'required', 'iter': 'required', 'body': 'list', 'orelse': 'list', 'type_comment': 'optional'},
    AsyncFunctionDef: {'name': 'required', 'args': 'required', 'body': 'list', 'decorator_list': 'list', 'returns': 'optional', 'type_comment': 'optional', 'type_params': 'list'},
    AsyncWith: {'items': 'list', 'body': 'list', 'type_comment': 'optional'},
    Attribute: {'value': 'required', 'attr': 'required', 'ctx': 'ctx'},
    AugAssign: {'target': 'required', 'op': 'required', 'value': 'required'},
    Await: {'value': 'required'},
    BinOp: {'left': 'required', 'op': 'required', 'right': 'required'},
    BitAnd: {},
    BitOr: {},
    BitXor: {},
    BoolOp: {'op': 'required', 'values': 'list'},
    Break: {},
    Call: {'func': 'required', 'args': 'list', 'keywords': 'list'},
    ClassDef: {'name': 'required', 'bases': 'list', 'keywords': 'list', 'body': 'list', 'decorator_list': 'list', 'type_params': 'list'},
    Compare: {'left': 'required', 'ops': 'list', 'comparators': 'list'},
    Constant: {'value': 'required', 'kind': 'optional'},
    Continue: {},
    Del: {},
    Delete: {'targets': 'list'},
    Dict: {'keys': 'list', 'values': 'list'},
    DictComp: {'key': 'required', 'value': 'required', 'generators': 'list'},
    Div: {},
    Eq: {},
    ExceptHandler: {'type': 'optional', 'name': 'optional', 'body': 'list'},
    Expr: {'value': 'required'},
    Expression: {'body': 'required'},
    FloorDiv: {},
    For: {'target': 'required', 'iter': 'required', 'body': 'list', 'orelse': 'list', 'type_comment': 'optional'},
    FormattedValue: {'value': 'required', 'conversion': 'required', 'format_spec': 'optional'},
    FunctionDef: {'name': 'required', 'args': 'required', 'body': 'list', 'decorator_list': 'list', 'returns': 'optional', 'type_comment': 'optional', 'type_params': 'list'},
    FunctionType: {'argtypes': 'list', 'returns': 'required'},
    GeneratorExp: {'elt': 'required', 'generators': 'list'},
    Global: {'names': 'list'},
    Gt: {},
    GtE: {},
    If: {'test': 'required', 'body': 'list', 'orelse': 'list'},
    IfExp: {'test': 'required', 'body': 'required', 'orelse': 'required'},
    Import: {'names': 'list'},
    ImportFrom: {'module': 'optional', 'names': 'list', 'level': 'optional'},
    In: {},
    Interactive: {'body': 'list'},
    Interpolation: {'value': 'required', 'str': 'required', 'conversion': 'required', 'format_spec': 'optional'},
    Invert: {},
    Is: {},
    IsNot: {},
    JoinedStr: {'values': 'list'},
    LShift: {},
    Lambda: {'args': 'required', 'body': 'required'},
    List: {'elts': 'list', 'ctx': 'ctx'},
    ListComp: {'elt': 'required', 'generators': 'list'},
    Load: {},
    Lt: {},
    LtE: {},
    MatMult: {},
    Match: {'subject': 'required', 'cases': 'list'},
    MatchAs: {'pattern': 'optional', 'name': 'optional'},
    MatchClass: {'cls': 'required', 'patterns': 'list', 'kwd_attrs': 'list', 'kwd_patterns': 'list'},
    MatchMapping: {'keys': 'list', 'patterns': 'list', 'rest': 'optional'},
    MatchOr: {'patterns': 'list'},
    MatchSequence: {'patterns': 'list'},
    MatchSingleton: {'value': 'required'},
    MatchStar: {'name': 'optional'},
    MatchValue: {'value': 'required'},
    Mod: {},
    Module: {'body': 'list', 'type_ignores': 'list'},
    Mult: {},
    Name: {'id': 'required', 'ctx': 'ctx'},
    NamedExpr: {'target': 'required', 'value': 'required'},
    Nonlocal: {'names': 'list'},
    Not: {},
    NotEq: {},
    NotIn: {},
    Or: {},
    ParamSpec: {'name': 'required', 'default_value': 'optional'},
    Pass: {},
    Pow: {},
    RShift: {},
    Raise: {'exc': 'optional', 'cause': 'optional'},
    Return: {'value': 'optional'},
    Set: {'elts': 'list'},
    SetComp: {'elt': 'required', 'generators': 'list'},
    Slice: {'lower': 'optional', 'upper': 'optional', 'step': 'optional'},
    Starred: {'value': 'required', 'ctx': 'ctx'},
    Store: {},
    Sub: {},
    Subscript: {'value': 'required', 'slice': 'required', 'ctx': 'ctx'},
    TemplateStr: {'values': 'list'},
    Try: {'body': 'list', 'handlers': 'list', 'orelse': 'list', 'finalbody': 'list'},
    TryStar: {'body': 'list', 'handlers': 'list', 'orelse': 'list', 'finalbody': 'list'},
    Tuple: {'elts': 'list', 'ctx': 'ctx'},
    TypeAlias: {'name': 'required', 'type_params': 'list', 'value': 'required'},
    TypeIgnore: {'lineno': 'required', 'tag': 'required'},
    TypeVar: {'name': 'required', 'bound': 'optional', 'default_value': 'optional'},
    TypeVarTuple: {'name': 'required', 'default_value': 'optional'},
    UAdd: {},
    USub: {},
    UnaryOp: {'op': 'required', 'operand': 'required'},
    While: {'test': 'required', 'body': 'list', 'orelse': 'list'},
    With: {'items': 'list', 'body': 'list', 'type_comment': 'optional'},
    Yield: {'value': 'optional'},
    YieldFrom: {'value': 'required'},
    alias: {'name': 'required', 'asname': 'optional'},
    arg: {'arg': 'required', 'annotation': 'optional', 'type_comment': 'optional'},
    arguments: {'posonlyargs': 'list', 'args': 'list', 'vararg': 'optional', 'kwonlyargs': 'list', 'kw_defaults': 'list', 'kwarg': 'optional', 'defaults': 'list'},
    comprehension: {'target': 'required', 'iter': 'required', 'ifs': 'list', 'is_async': 'required'},
    keyword: {'arg': 'optional', 'value': 'required'},
    match_case: {'pattern': 'required', 'guard': 'optional', 'body': 'list'},
    withitem: {'context_expr': 'required', 'optional_vars': 'optional'},
}


AnnAssign.value = None
Assert.msg = None
Assign.type_comment = None
AsyncFor.type_comment = None
AsyncFunctionDef.returns = None
AsyncFunctionDef.type_comment = None
AsyncWith.type_comment = None
Constant.kind = None
ExceptHandler.type = None
ExceptHandler.name = None
For.type_comment = None
FormattedValue.format_spec = None
FunctionDef.returns = None
FunctionDef.type_comment = None
ImportFrom.module = None
ImportFrom.level = None
Interpolation.format_spec = None
MatchAs.pattern = None
MatchAs.name = None
MatchMapping.rest = None
MatchStar.name = None
ParamSpec.default_value = None
Raise.exc = None
Raise.cause = None
Return.value = None
Slice.lower = None
Slice.upper = None
Slice.step = None
TypeVar.bound = None
TypeVar.default_value = None
TypeVarTuple.default_value = None
With.type_comment = None
Yield.value = None
alias.asname = None
arg.annotation = None
arg.type_comment = None
arguments.vararg = None
arguments.kwarg = None
keyword.arg = None
match_case.guard = None
withitem.optional_vars = None

for _cls in _classes:
    _node_layout(_cls)
del _cls, _classes, _node_layout
`;
