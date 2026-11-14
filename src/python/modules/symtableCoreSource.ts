// The `_symtable` module: a transcription of CPython 3.14's `Python/symtable.c` and `Python/future.c` in Python,
// over the trees of `ast.parse`. An entry's `id` is a serial number where CPython gives the address of the syntax
// node keying the entry. Its sets of names are dicts, so names propagate in insertion order where CPython's follow
// string hashes.
export const SYMTABLE_CORE_SOURCE = String.raw`import ast as _ast

USE = 16
DEF_GLOBAL = 1
DEF_NONLOCAL = 8
DEF_LOCAL = 2
DEF_PARAM = 4
DEF_TYPE_PARAM = 1024
DEF_FREE_CLASS = 64
DEF_IMPORT = 128
DEF_BOUND = 134
DEF_ANNOT = 256
DEF_COMP_ITER = 512
DEF_COMP_CELL = 2048
TYPE_FUNCTION = 0
TYPE_CLASS = 1
TYPE_MODULE = 2
TYPE_ANNOTATION = 3
TYPE_TYPE_ALIAS = 4
TYPE_TYPE_PARAMETERS = 5
TYPE_TYPE_VARIABLE = 6
LOCAL = 1
GLOBAL_EXPLICIT = 2
GLOBAL_IMPLICIT = 3
FREE = 4
CELL = 5
SCOPE_OFF = 12
SCOPE_MASK = 15

_FUTURE_FEATURES = ('nested_scopes', 'generators', 'division', 'absolute_import', 'with_statement',
                    'print_function', 'unicode_literals', 'barry_as_FLUFL', 'generator_stop', 'annotations')
_FUNCTION_LIKE = (TYPE_FUNCTION, TYPE_ANNOTATION, TYPE_TYPE_VARIABLE, TYPE_TYPE_ALIAS, TYPE_TYPE_PARAMETERS)
_NO_COMPREHENSION = 0
_COMPREHENSIONS = {'ListComp': (1, 'listcomp'), 'DictComp': (2, 'dictcomp'), 'SetComp': (3, 'setcomp'),
                   'GeneratorExp': (4, 'genexpr')}
_YIELD_IN_COMPREHENSION = {1: "'yield' inside list comprehension", 2: "'yield' inside dict comprehension",
                           3: "'yield' inside set comprehension", 4: "'yield' inside generator expression"}
_NAMED_EXPR_COMP_IN = {
    TYPE_CLASS: 'assignment expression within a comprehension cannot be used in a class body',
    TYPE_TYPE_PARAMETERS: 'assignment expression within a comprehension cannot be used within the definition of a generic',
    TYPE_TYPE_ALIAS: 'assignment expression within a comprehension cannot be used in a type alias',
    TYPE_TYPE_VARIABLE: 'assignment expression within a comprehension cannot be used in a TypeVar bound',
}
_next_id = [4345298944]


def symtable(*args):
    if len(args) != 3:
        raise TypeError(f'symtable expected 3 arguments, got {len(args)}')
    source, filename, startstr = args
    filename = _fs_decode(filename)
    if not isinstance(startstr, str):
        raise TypeError(f'symtable() argument 3 must be str, not {type(startstr).__name__}')
    if isinstance(source, str):
        has_null = '\0' in source
    elif isinstance(source, (bytes, bytearray)):
        has_null = b'\0' in source
        source = bytes(source)
    else:
        raise TypeError('symtable() arg 1 must be a string or bytes object')
    if has_null:
        raise SyntaxError('source code string cannot contain null bytes')
    if startstr not in ('exec', 'eval', 'single'):
        raise ValueError("symtable() arg 3 must be 'exec' or 'eval' or 'single'")
    mod = _ast.parse(source, filename, startstr)
    builder = _Builder(filename, *_future_features(mod, filename))
    return builder.build(mod)


def _fs_decode(filename):
    if isinstance(filename, str):
        return filename
    if isinstance(filename, bytes):
        return filename.decode('utf-8', 'surrogateescape')
    fspath = getattr(type(filename), '__fspath__', None)
    if fspath is None:
        raise TypeError(f'expected str, bytes or os.PathLike object, not {type(filename).__name__}')
    return _fs_decode(fspath(filename))


def _location(node):
    return (node.lineno, node.col_offset, node.end_lineno, node.end_col_offset)


def _error(message, filename, loc):
    error = SyntaxError(message)
    error.filename = filename
    error.lineno, error.offset, error.end_lineno, error.end_offset = loc[0], loc[1] + 1, loc[2], loc[3] + 1
    return error


def _docstring(body):
    if not body or type(body[0]).__name__ != 'Expr':
        return False
    value = body[0].value
    return type(value).__name__ == 'Constant' and type(value.value) is str


def _future_features(mod, filename):
    annotations = False
    location = (-1, -1, -1, -1)
    if type(mod).__name__ not in ('Module', 'Interactive'):
        return annotations, location
    body = mod.body
    for s in body[1:] if _docstring(body) else body:
        if type(s).__name__ != 'ImportFrom' or s.level != 0 or s.module != '__future__':
            break
        for alias in s.names:
            if alias.name == 'annotations':
                annotations = True
            elif alias.name == 'braces':
                raise _error('not a chance', filename, _location(alias))
            elif alias.name not in _FUTURE_FEATURES:
                raise _error(f'future feature {alias.name} is not defined', filename, _location(alias))
        location = _location(s)
    return annotations, location


def _mangle(private, name):
    if private is None or not name.startswith('__') or name.endswith('__') or '.' in name:
        return name
    stripped = private.lstrip('_')
    if not stripped:
        return name
    return '_' + stripped + name


class _Entry:
    def __init__(self, name, block, loc, nested, filename):
        _next_id[0] += 16
        self.id = _next_id[0]
        self.name = name
        self.symbols = {}
        self.varnames = []
        self.children = []
        self.nested = nested
        self.type = block
        self.lineno = loc[0]
        self._loc = loc
        self._filename = filename
        self._directives = []
        self._mangled_names = None
        self._scope_info = None
        self._generator = False
        self._coroutine = False
        self._comprehension = _NO_COMPREHENSION
        self._comp_inlined = False
        self._comp_iter_target = False
        self._comp_iter_expr = 0
        self._can_see_class_scope = False
        self._has_conditional_annotations = False
        self._in_conditional_block = False
        self._in_unevaluated_annotation = False
        self._annotation_block = None

    def __repr__(self):
        return f'<symtable entry {self.name}({self.id!r}), line {self.lineno}>'


_c_type_name(_Entry, 'symtable entry')
_Entry.__name__ = _Entry.__qualname__ = 'symtable entry'
_Entry.__module__ = 'builtins'


class _Builder:
    def __init__(self, filename, future_annotations, future_location):
        self.filename = filename
        self.future_annotations = future_annotations
        self.future_location = future_location
        self.cur = None
        self.stack = []
        self.globals = None
        self.private = None

    def build(self, mod):
        self.enter_block('top', TYPE_MODULE, (0, 0, 0, 0))
        top = self.cur
        kind = type(mod).__name__
        if kind == 'Expression':
            self.visit_expr(mod.body)
        else:
            for s in mod.body:
                self.visit_stmt(s)
        self.exit_block()
        _analyze_block(top, None, {}, {}, {}, None)
        return top

    def error(self, message, loc):
        return _error(message, self.filename, loc)

    # Blocks

    def new_entry(self, name, block, loc):
        cur = self.cur
        nested = 1 if cur is not None and (cur.nested or cur.type in _FUNCTION_LIKE) else 0
        return _Entry(name, block, loc, nested, self.filename)

    def enter_existing_block(self, ste, add_to_children):
        self.stack.append(ste)
        prev = self.cur
        if prev is not None:
            ste._comp_iter_expr = prev._comp_iter_expr
            if prev._mangled_names is not None and ste.type != TYPE_CLASS:
                ste._mangled_names = prev._mangled_names
        self.cur = ste
        if self.future_annotations and ste.type == TYPE_ANNOTATION:
            return
        if ste.type == TYPE_MODULE:
            self.globals = ste.symbols
        if add_to_children and prev is not None:
            prev.children.append(ste)

    def enter_block(self, name, block, loc):
        self.enter_existing_block(self.new_entry(name, block, loc), True)
        if block in (TYPE_ANNOTATION, TYPE_TYPE_VARIABLE, TYPE_TYPE_ALIAS):
            self.add_def('.format', DEF_PARAM, loc)
            self.add_def('.format', USE, loc)

    def exit_block(self):
        self.stack.pop()
        self.cur = self.stack[-1] if self.stack else None

    def enter_type_param_block(self, name, has_defaults, has_kwdefaults, is_class, loc):
        current_type = self.cur.type
        self.enter_block(name, TYPE_TYPE_PARAMETERS, loc)
        if current_type == TYPE_CLASS:
            self.cur._can_see_class_scope = True
            self.add_def('__classdict__', USE, loc)
        if is_class:
            self.add_def('.type_params', DEF_LOCAL, loc)
            self.add_def('.type_params', USE, loc)
            self.add_def('.generic_base', DEF_LOCAL, loc)
            self.add_def('.generic_base', USE, loc)
        if has_defaults:
            self.add_def('.defaults', DEF_PARAM, loc)
        if has_kwdefaults:
            self.add_def('.kwdefaults', DEF_PARAM, loc)

    # Symbols

    def maybe_mangle(self, ste, name):
        if ste._mangled_names is not None and name not in ste._mangled_names:
            return name
        return _mangle(self.private, name)

    def lookup_entry(self, ste, name):
        return ste.symbols.get(self.maybe_mangle(ste, name), 0)

    def add_def_helper(self, name, flag, ste, loc):
        mangled = self.maybe_mangle(self.cur, name)
        symbols = ste.symbols
        val = symbols.get(mangled)
        if val is None:
            val = flag
        else:
            if flag & DEF_PARAM and val & DEF_PARAM:
                raise self.error(f"duplicate argument '{name}' in function definition", loc)
            if flag & DEF_TYPE_PARAM and val & DEF_TYPE_PARAM:
                raise self.error(f"duplicate type parameter '{name}'", loc)
            val |= flag
        if ste._comp_iter_target:
            if val & (DEF_GLOBAL | DEF_NONLOCAL):
                raise self.error(f"comprehension inner loop cannot rebind assignment expression target '{name}'", loc)
            val |= DEF_COMP_ITER
        symbols[mangled] = val
        if flag & DEF_PARAM:
            ste.varnames.append(mangled)
        elif flag & DEF_GLOBAL:
            self.globals[mangled] = self.globals.get(mangled, 0) | flag

    def check_name(self, name, loc, ctx):
        if name == '__debug__':
            if ctx == 'Store':
                raise self.error('cannot assign to __debug__', loc)
            if ctx == 'Del':
                raise self.error('cannot delete __debug__', loc)

    def add_def_ctx(self, name, flag, loc, ctx):
        if flag & (DEF_PARAM | DEF_LOCAL | DEF_IMPORT):
            self.check_name(name, loc, ctx)
        if flag & DEF_TYPE_PARAM and self.cur._mangled_names is not None:
            self.cur._mangled_names.add(name)
        self.add_def_helper(name, flag, self.cur, loc)

    def add_def(self, name, flag, loc):
        self.add_def_ctx(name, flag, loc, 'Load' if flag == USE else 'Store')

    def record_directive(self, name, loc):
        self.cur._directives.append((self.maybe_mangle(self.cur, name),) + loc)

    def check_keywords(self, keywords):
        for keyword in keywords:
            if keyword.arg is not None:
                self.check_name(keyword.arg, _location(keyword), 'Store')

    # Statements

    def visit_stmts(self, stmts):
        for s in stmts:
            self.visit_stmt(s)

    def visit_exprs(self, exprs):
        for e in exprs:
            if e is not None:
                self.visit_expr(e)

    def visit_stmt(self, s):
        _STMT_VISITORS[type(s).__name__](self, s)

    def visit_function(self, s):
        loc = _location(s)
        args = s.args
        self.add_def(s.name, DEF_LOCAL, loc)
        self.visit_exprs(args.defaults)
        self.visit_exprs(args.kw_defaults)
        self.visit_exprs(s.decorator_list)
        if s.type_params:
            has_kwdefaults = any(default is not None for default in args.kw_defaults)
            self.enter_type_param_block(s.name, True, has_kwdefaults, False, loc)
            for tp in s.type_params:
                self.visit_type_param(tp)
        new_ste = self.new_entry(s.name, TYPE_FUNCTION, loc)
        self.visit_annotations(s, args, s.returns)
        self.enter_existing_block(new_ste, True)
        if type(s).__name__ == 'AsyncFunctionDef':
            self.cur._coroutine = True
        self.visit_arguments(args)
        self.visit_stmts(s.body)
        self.exit_block()
        if s.type_params:
            self.exit_block()

    def visit_class(self, s):
        loc = _location(s)
        self.add_def(s.name, DEF_LOCAL, loc)
        self.visit_exprs(s.decorator_list)
        saved_private = self.private
        if s.type_params:
            self.enter_type_param_block(s.name, False, False, True, loc)
            self.private = s.name
            self.cur._mangled_names = set()
            for tp in s.type_params:
                self.visit_type_param(tp)
        self.visit_exprs(s.bases)
        self.check_keywords(s.keywords)
        for keyword in s.keywords:
            self.visit_expr(keyword.value)
        self.enter_block(s.name, TYPE_CLASS, loc)
        self.private = s.name
        if s.type_params:
            self.add_def('__type_params__', DEF_LOCAL, loc)
            self.add_def('.type_params', USE, loc)
        self.visit_stmts(s.body)
        self.exit_block()
        if s.type_params:
            self.exit_block()
        self.private = saved_private

    def visit_type_alias(self, s):
        self.visit_expr(s.name)
        name = s.name.id
        is_in_class = self.cur.type == TYPE_CLASS
        loc = _location(s)
        if s.type_params:
            self.enter_type_param_block(name, False, False, False, loc)
            for tp in s.type_params:
                self.visit_type_param(tp)
        self.enter_block(name, TYPE_TYPE_ALIAS, loc)
        self.cur._can_see_class_scope = is_in_class
        if is_in_class:
            self.add_def('__classdict__', USE, _location(s.value))
        self.visit_expr(s.value)
        self.exit_block()
        if s.type_params:
            self.exit_block()

    def visit_return(self, s):
        if s.value is not None:
            self.visit_expr(s.value)

    def visit_delete(self, s):
        self.visit_exprs(s.targets)

    def visit_assign(self, s):
        self.visit_exprs(s.targets)
        self.visit_expr(s.value)

    def visit_ann_assign(self, s):
        target = s.target
        if type(target).__name__ == 'Name':
            cur = self.lookup_entry(self.cur, target.id)
            if cur & (DEF_GLOBAL | DEF_NONLOCAL) and self.cur.symbols is not self.globals and s.simple:
                kind = 'global' if cur & DEF_GLOBAL else 'nonlocal'
                raise self.error(f"annotated name '{target.id}' can't be {kind}", _location(s))
            if s.simple:
                self.add_def(target.id, DEF_ANNOT | DEF_LOCAL, _location(target))
            elif s.value is not None:
                self.add_def(target.id, DEF_LOCAL, _location(target))
        else:
            self.visit_expr(target)
        self.visit_annotation(s.annotation)
        if s.value is not None:
            self.visit_expr(s.value)

    def visit_aug_assign(self, s):
        self.visit_expr(s.target)
        self.visit_expr(s.value)

    def visit_for(self, s):
        if type(s).__name__ == 'AsyncFor':
            self.raise_if_not_coroutine("'async for' outside async function", _location(s))
        self.visit_expr(s.target)
        self.visit_expr(s.iter)
        self.conditional(s.body, s.orelse)

    def conditional(self, *blocks):
        saved = self.cur._in_conditional_block
        self.cur._in_conditional_block = True
        for block in blocks:
            self.visit_stmts(block)
        self.cur._in_conditional_block = saved

    def visit_while(self, s):
        self.visit_expr(s.test)
        self.conditional(s.body, s.orelse)

    def visit_if(self, s):
        self.visit_expr(s.test)
        self.conditional(s.body, s.orelse)

    def visit_match(self, s):
        self.visit_expr(s.subject)
        saved = self.cur._in_conditional_block
        self.cur._in_conditional_block = True
        for case in s.cases:
            self.visit_pattern(case.pattern)
            if case.guard is not None:
                self.visit_expr(case.guard)
            self.visit_stmts(case.body)
        self.cur._in_conditional_block = saved

    def visit_raise(self, s):
        if s.exc is not None:
            self.visit_expr(s.exc)
            if s.cause is not None:
                self.visit_expr(s.cause)

    def visit_try(self, s):
        saved = self.cur._in_conditional_block
        self.cur._in_conditional_block = True
        self.visit_stmts(s.body)
        for handler in s.handlers:
            if handler.type is not None:
                self.visit_expr(handler.type)
            if handler.name is not None:
                self.add_def(handler.name, DEF_LOCAL, _location(handler))
            self.visit_stmts(handler.body)
        self.visit_stmts(s.orelse)
        self.visit_stmts(s.finalbody)
        self.cur._in_conditional_block = saved

    def visit_assert(self, s):
        self.visit_expr(s.test)
        if s.msg is not None:
            self.visit_expr(s.msg)

    def visit_import(self, s):
        for alias in s.names:
            self.visit_alias(alias)

    def visit_import_from(self, s):
        for alias in s.names:
            self.visit_alias(alias)
        fut = self.future_location
        if (s.module == '__future__' and s.level == 0 and
                (s.lineno > fut[0] or (s.lineno == fut[2] and s.col_offset > fut[3]))):
            raise self.error('from __future__ imports must occur at the beginning of the file', _location(s))

    def visit_alias(self, a):
        name = a.name if a.asname is None else a.asname
        if name == '*':
            if self.cur.type != TYPE_MODULE:
                raise self.error('import * only allowed at module level', _location(a))
            return
        self.add_def(name.partition('.')[0], DEF_IMPORT, _location(a))

    def visit_global(self, s):
        self.declare(s, DEF_GLOBAL, 'global')

    def visit_nonlocal(self, s):
        self.declare(s, DEF_NONLOCAL, 'nonlocal')

    def declare(self, s, flag, kind):
        loc = _location(s)
        for name in s.names:
            cur = self.lookup_entry(self.cur, name)
            if cur & (DEF_PARAM | DEF_LOCAL | USE | DEF_ANNOT):
                if cur & DEF_PARAM:
                    message = f"name '{name}' is parameter and {kind}"
                elif cur & USE:
                    message = f"name '{name}' is used prior to {kind} declaration"
                elif cur & DEF_ANNOT:
                    message = f"annotated name '{name}' can't be {kind}"
                else:
                    message = f"name '{name}' is assigned to before {kind} declaration"
                raise self.error(message, loc)
            self.add_def(name, flag, loc)
            self.record_directive(name, loc)

    def visit_expr_stmt(self, s):
        self.visit_expr(s.value)

    def visit_nothing(self, s):
        pass

    def visit_with(self, s):
        if type(s).__name__ == 'AsyncWith':
            self.raise_if_not_coroutine("'async with' outside async function", _location(s))
        saved = self.cur._in_conditional_block
        self.cur._in_conditional_block = True
        for item in s.items:
            self.visit_expr(item.context_expr)
            if item.optional_vars is not None:
                self.visit_expr(item.optional_vars)
        self.visit_stmts(s.body)
        self.cur._in_conditional_block = saved

    def raise_if_not_coroutine(self, message, loc):
        if not self.cur._coroutine:
            raise self.error(message, loc)

    # Expressions

    def visit_expr(self, e):
        _EXPR_VISITORS[type(e).__name__](self, e)

    def visit_named_expr(self, e):
        self.raise_if_annotation_block('named expression', e)
        if self.cur._comp_iter_expr > 0:
            raise self.error('assignment expression cannot be used in a comprehension iterable expression',
                             _location(e))
        if self.cur._comprehension:
            self.extend_namedexpr_scope(e.target)
        self.visit_expr(e.value)
        self.visit_expr(e.target)

    def extend_namedexpr_scope(self, e):
        target_name = e.id
        loc = _location(e)
        for ste in reversed(self.stack):
            if ste._comprehension:
                target_in_scope = self.lookup_entry(ste, target_name)
                if target_in_scope & DEF_COMP_ITER and target_in_scope & DEF_LOCAL:
                    raise self.error(
                        f"assignment expression cannot rebind comprehension iteration variable '{target_name}'", loc)
                continue
            if ste.type == TYPE_FUNCTION:
                if self.lookup_entry(ste, target_name) & DEF_GLOBAL:
                    self.add_def(target_name, DEF_GLOBAL, loc)
                else:
                    self.add_def(target_name, DEF_NONLOCAL, loc)
                self.record_directive(target_name, loc)
                self.add_def_helper(target_name, DEF_LOCAL, ste, loc)
                return
            if ste.type == TYPE_MODULE:
                self.add_def(target_name, DEF_GLOBAL, loc)
                self.record_directive(target_name, loc)
                self.add_def_helper(target_name, DEF_GLOBAL, ste, loc)
                return
            if ste.type in _NAMED_EXPR_COMP_IN:
                raise self.error(_NAMED_EXPR_COMP_IN[ste.type], loc)

    def visit_bool_op(self, e):
        self.visit_exprs(e.values)

    def visit_bin_op(self, e):
        self.visit_expr(e.left)
        self.visit_expr(e.right)

    def visit_unary_op(self, e):
        self.visit_expr(e.operand)

    def visit_lambda(self, e):
        self.visit_exprs(e.args.defaults)
        self.visit_exprs(e.args.kw_defaults)
        self.enter_block('lambda', TYPE_FUNCTION, _location(e))
        self.visit_arguments(e.args)
        self.visit_expr(e.body)
        self.exit_block()

    def visit_if_exp(self, e):
        self.visit_expr(e.test)
        self.visit_expr(e.body)
        self.visit_expr(e.orelse)

    def visit_dict(self, e):
        self.visit_exprs(e.keys)
        self.visit_exprs(e.values)

    def visit_elts(self, e):
        self.visit_exprs(e.elts)

    def visit_comprehension_expr(self, e):
        kind = type(e).__name__
        comprehension, scope_name = _COMPREHENSIONS[kind]
        is_generator = kind == 'GeneratorExp'
        generators = e.generators
        outermost = generators[0]
        self.cur._comp_iter_expr += 1
        self.visit_expr(outermost.iter)
        self.cur._comp_iter_expr -= 1
        self.enter_block(scope_name, TYPE_FUNCTION, _location(e))
        cur = self.cur
        cur._comprehension = comprehension
        if outermost.is_async:
            cur._coroutine = True
        self.add_def('.0', DEF_PARAM, cur._loc)
        cur._comp_iter_target = True
        self.visit_expr(outermost.target)
        cur._comp_iter_target = False
        self.visit_exprs(outermost.ifs)
        for generator in generators[1:]:
            self.visit_comprehension(generator)
        if kind == 'DictComp':
            self.visit_expr(e.value)
            self.visit_expr(e.key)
        else:
            self.visit_expr(e.elt)
        cur._generator = is_generator
        is_async = cur._coroutine and not is_generator
        self.exit_block()
        if (is_async and not (self.cur.type == TYPE_FUNCTION and self.cur._coroutine) and
                self.cur._comprehension == _NO_COMPREHENSION):
            raise self.error('asynchronous comprehension outside of an asynchronous function', _location(e))
        if is_async:
            self.cur._coroutine = True

    def visit_comprehension(self, lc):
        cur = self.cur
        cur._comp_iter_target = True
        self.visit_expr(lc.target)
        cur._comp_iter_target = False
        cur._comp_iter_expr += 1
        self.visit_expr(lc.iter)
        cur._comp_iter_expr -= 1
        self.visit_exprs(lc.ifs)
        if lc.is_async:
            cur._coroutine = True

    def visit_yield(self, e):
        self.raise_if_annotation_block('yield expression', e)
        if e.value is not None:
            self.visit_expr(e.value)
        self.cur._generator = True
        if self.cur._comprehension:
            raise self.error(_YIELD_IN_COMPREHENSION[self.cur._comprehension], _location(e))

    def visit_await(self, e):
        self.raise_if_annotation_block('await expression', e)
        cur = self.cur
        if cur.type not in _FUNCTION_LIKE:
            raise self.error("'await' outside function", _location(e))
        if not (cur.type == TYPE_FUNCTION and cur._coroutine) and cur._comprehension == _NO_COMPREHENSION:
            raise self.error("'await' outside async function", _location(e))
        self.visit_expr(e.value)
        cur._coroutine = True

    def visit_compare(self, e):
        self.visit_expr(e.left)
        self.visit_exprs(e.comparators)

    def visit_call(self, e):
        self.visit_expr(e.func)
        self.visit_exprs(e.args)
        self.check_keywords(e.keywords)
        for keyword in e.keywords:
            self.visit_expr(keyword.value)

    def visit_formatted_value(self, e):
        self.visit_expr(e.value)
        if e.format_spec is not None:
            self.visit_expr(e.format_spec)

    def visit_values(self, e):
        self.visit_exprs(e.values)

    def visit_attribute(self, e):
        self.check_name(e.attr, _location(e), type(e.ctx).__name__)
        self.visit_expr(e.value)

    def visit_subscript(self, e):
        self.visit_expr(e.value)
        self.visit_expr(e.slice)

    def visit_starred(self, e):
        self.visit_expr(e.value)

    def visit_slice(self, e):
        self.visit_exprs((e.lower, e.upper, e.step))

    def visit_name(self, e):
        if self.cur._in_unevaluated_annotation:
            return
        ctx = type(e.ctx).__name__
        loc = _location(e)
        self.add_def_ctx(e.id, USE if ctx == 'Load' else DEF_LOCAL, loc, ctx)
        if ctx == 'Load' and self.cur.type in _FUNCTION_LIKE and e.id == 'super':
            self.add_def('__class__', USE, loc)

    def raise_if_annotation_block(self, name, e):
        block = self.cur.type
        if block == TYPE_ANNOTATION:
            message = f'{name} cannot be used within an annotation'
        elif block == TYPE_TYPE_VARIABLE:
            message = f'{name} cannot be used within {self.cur._scope_info}'
        elif block == TYPE_TYPE_ALIAS:
            message = f'{name} cannot be used within a type alias'
        elif block == TYPE_TYPE_PARAMETERS:
            message = f'{name} cannot be used within the definition of a generic'
        else:
            return
        raise self.error(message, _location(e))

    # Type parameters, patterns, arguments and annotations

    def visit_type_param(self, tp):
        kind = type(tp).__name__
        self.add_def(tp.name, DEF_TYPE_PARAM | DEF_LOCAL, _location(tp))
        if kind == 'TypeVar':
            info = None
            if tp.bound is not None:
                info = 'a TypeVar constraint' if type(tp.bound).__name__ == 'Tuple' else 'a TypeVar bound'
            self.visit_bound_or_default(tp.bound, tp, info)
            self.visit_bound_or_default(tp.default_value, tp, 'a TypeVar default')
        else:
            self.visit_bound_or_default(tp.default_value, tp, f'a {kind} default')

    def visit_bound_or_default(self, e, tp, scope_info):
        if tp.name == '__classdict__':
            raise self.error("reserved name '__classdict__' cannot be used for type parameter", _location(tp))
        if e is None:
            return
        is_in_class = self.cur._can_see_class_scope
        self.enter_block(tp.name, TYPE_TYPE_VARIABLE, _location(e))
        self.cur._can_see_class_scope = is_in_class
        if is_in_class:
            self.add_def('__classdict__', USE, _location(e))
        self.cur._scope_info = scope_info
        self.visit_expr(e)
        self.exit_block()

    def visit_pattern(self, p):
        kind = type(p).__name__
        if kind == 'MatchValue':
            self.visit_expr(p.value)
        elif kind == 'MatchSequence' or kind == 'MatchOr':
            for pattern in p.patterns:
                self.visit_pattern(pattern)
        elif kind == 'MatchStar':
            if p.name is not None:
                self.add_def(p.name, DEF_LOCAL, _location(p))
        elif kind == 'MatchMapping':
            self.visit_exprs(p.keys)
            for pattern in p.patterns:
                self.visit_pattern(pattern)
            if p.rest is not None:
                self.add_def(p.rest, DEF_LOCAL, _location(p))
        elif kind == 'MatchClass':
            self.visit_class_pattern(p)
        elif kind == 'MatchAs':
            if p.pattern is not None:
                self.visit_pattern(p.pattern)
            if p.name is not None:
                self.add_def(p.name, DEF_LOCAL, _location(p))

    def visit_class_pattern(self, p):
        self.visit_expr(p.cls)
        for pattern in p.patterns:
            self.visit_pattern(pattern)
        for attr, pattern in zip(p.kwd_attrs, p.kwd_patterns):
            self.check_name(attr, _location(pattern), 'Store')
        for pattern in p.kwd_patterns:
            self.visit_pattern(pattern)

    def visit_arguments(self, a):
        for arg in a.posonlyargs + a.args + a.kwonlyargs:
            self.add_def(arg.arg, DEF_PARAM, _location(arg))
        if a.vararg is not None:
            self.add_def(a.vararg.arg, DEF_PARAM, _location(a.vararg))
        if a.kwarg is not None:
            self.add_def(a.kwarg.arg, DEF_PARAM, _location(a.kwarg))

    def visit_annotation(self, annotation):
        cur = self.cur
        is_unevaluated = cur.type == TYPE_FUNCTION
        loc = _location(annotation)
        if (((cur.type == TYPE_CLASS and cur._in_conditional_block) or cur.type == TYPE_MODULE)
                and not cur._has_conditional_annotations):
            cur._has_conditional_annotations = True
            self.add_def('__conditional_annotations__', USE, loc)
        if cur._annotation_block is None:
            self.enter_block('__annotate__', TYPE_ANNOTATION, loc)
            cur._annotation_block = self.cur
            if cur.type == TYPE_CLASS and not self.future_annotations:
                self.cur._can_see_class_scope = True
                self.add_def('__classdict__', USE, loc)
        else:
            self.enter_existing_block(cur._annotation_block, False)
        if is_unevaluated:
            self.cur._in_unevaluated_annotation = True
        self.visit_expr(annotation)
        if is_unevaluated:
            self.cur._in_unevaluated_annotation = False
        self.exit_block()

    def visit_annotations(self, s, a, returns):
        is_in_class = self.cur._can_see_class_scope
        current_type = self.cur.type
        loc = _location(s)
        self.enter_block('__annotate__', TYPE_ANNOTATION, loc)
        if is_in_class or current_type == TYPE_CLASS:
            self.cur._can_see_class_scope = True
            self.add_def('__classdict__', USE, loc)
        for arg in a.posonlyargs + a.args:
            if arg.annotation is not None:
                self.visit_expr(arg.annotation)
        for arg in (a.vararg, a.kwarg):
            if arg is not None and arg.annotation is not None:
                self.visit_expr(arg.annotation)
        for arg in a.kwonlyargs:
            if arg.annotation is not None:
                self.visit_expr(arg.annotation)
        if returns is not None:
            self.visit_expr(returns)
        self.exit_block()


_STMT_VISITORS = {
    'FunctionDef': _Builder.visit_function, 'AsyncFunctionDef': _Builder.visit_function,
    'ClassDef': _Builder.visit_class, 'TypeAlias': _Builder.visit_type_alias, 'Return': _Builder.visit_return,
    'Delete': _Builder.visit_delete, 'Assign': _Builder.visit_assign, 'AnnAssign': _Builder.visit_ann_assign,
    'AugAssign': _Builder.visit_aug_assign, 'For': _Builder.visit_for, 'AsyncFor': _Builder.visit_for,
    'While': _Builder.visit_while, 'If': _Builder.visit_if, 'Match': _Builder.visit_match,
    'Raise': _Builder.visit_raise, 'Try': _Builder.visit_try, 'TryStar': _Builder.visit_try,
    'Assert': _Builder.visit_assert, 'Import': _Builder.visit_import, 'ImportFrom': _Builder.visit_import_from,
    'Global': _Builder.visit_global, 'Nonlocal': _Builder.visit_nonlocal, 'Expr': _Builder.visit_expr_stmt,
    'Pass': _Builder.visit_nothing, 'Break': _Builder.visit_nothing, 'Continue': _Builder.visit_nothing,
    'With': _Builder.visit_with, 'AsyncWith': _Builder.visit_with,
}
_EXPR_VISITORS = {
    'NamedExpr': _Builder.visit_named_expr, 'BoolOp': _Builder.visit_bool_op, 'BinOp': _Builder.visit_bin_op,
    'UnaryOp': _Builder.visit_unary_op, 'Lambda': _Builder.visit_lambda, 'IfExp': _Builder.visit_if_exp,
    'Dict': _Builder.visit_dict, 'Set': _Builder.visit_elts, 'GeneratorExp': _Builder.visit_comprehension_expr,
    'ListComp': _Builder.visit_comprehension_expr, 'SetComp': _Builder.visit_comprehension_expr,
    'DictComp': _Builder.visit_comprehension_expr, 'Yield': _Builder.visit_yield,
    'YieldFrom': _Builder.visit_yield, 'Await': _Builder.visit_await, 'Compare': _Builder.visit_compare,
    'Call': _Builder.visit_call, 'FormattedValue': _Builder.visit_formatted_value,
    'Interpolation': _Builder.visit_formatted_value, 'JoinedStr': _Builder.visit_values,
    'TemplateStr': _Builder.visit_values, 'Constant': _Builder.visit_nothing,
    'Attribute': _Builder.visit_attribute, 'Subscript': _Builder.visit_subscript,
    'Starred': _Builder.visit_starred, 'Slice': _Builder.visit_slice, 'Name': _Builder.visit_name,
    'List': _Builder.visit_elts, 'Tuple': _Builder.visit_elts,
}


def _analyze_block(ste, bound, free, global_, type_params, class_entry):
    local = {}
    scopes = {}
    newglobal = {}
    newfree = {}
    newbound = {}
    inlined_cells = {}
    is_class = ste.type == TYPE_CLASS
    if is_class:
        newglobal.update(global_)
        if bound is not None:
            newbound.update(bound)
    for name, flags in ste.symbols.items():
        _analyze_name(ste, scopes, name, flags, bound, local, free, global_, type_params, class_entry)
    if not is_class:
        if ste.type in _FUNCTION_LIKE:
            newbound.update(local)
        if bound is not None:
            newbound.update(bound)
        newglobal.update(global_)
    else:
        newbound['__class__'] = None
        newbound['__classdict__'] = None
        newbound['__conditional_annotations__'] = None
    for entry in ste.children:
        new_class_entry = None
        if entry._can_see_class_scope:
            new_class_entry = ste if is_class else class_entry
        inline_comp = entry._comprehension and not entry._generator and not ste._can_see_class_scope
        child_free = dict(newfree)
        _analyze_block(entry, dict(newbound), child_free, dict(newglobal), dict(type_params), new_class_entry)
        if inline_comp:
            _inline_comprehension(ste, entry, scopes, child_free, inlined_cells)
            entry._comp_inlined = True
        newfree.update(child_free)
    children = ste.children
    for i in range(len(children) - 1, -1, -1):
        entry = children[i]
        if entry._comp_inlined:
            children[i:i + 1] = entry.children
    if ste.type in _FUNCTION_LIKE:
        _analyze_cells(scopes, newfree, inlined_cells)
    elif is_class:
        _drop_class_free(newfree)
    _update_symbols(ste.symbols, scopes, bound, newfree, inlined_cells, is_class or ste._can_see_class_scope)
    free.update(newfree)


def _directive_error(ste, name, message):
    for directive in ste._directives:
        if directive[0] == name:
            return _error(message, ste._filename, directive[1:])
    return RuntimeError('BUG: internal directive bookkeeping broken')


def _analyze_name(ste, scopes, name, flags, bound, local, free, global_, type_params, class_entry):
    if flags & DEF_GLOBAL:
        if flags & DEF_NONLOCAL:
            raise _directive_error(ste, name, f"name '{name}' is nonlocal and global")
        scopes[name] = GLOBAL_EXPLICIT
        global_[name] = None
        if bound is not None:
            bound.pop(name, None)
        return
    if flags & DEF_NONLOCAL:
        if bound is None:
            raise _directive_error(ste, name, 'nonlocal declaration not allowed at module level')
        if name not in bound:
            raise _directive_error(ste, name, f"no binding for nonlocal '{name}' found")
        if name in type_params:
            raise _directive_error(ste, name, f"nonlocal binding not allowed for type parameter '{name}'")
        scopes[name] = FREE
        free[name] = None
        return
    if flags & DEF_BOUND:
        scopes[name] = LOCAL
        local[name] = None
        global_.pop(name, None)
        if flags & DEF_TYPE_PARAM:
            type_params[name] = None
        else:
            type_params.pop(name, None)
        return
    if class_entry is not None:
        class_flags = class_entry.symbols.get(name, 0)
        if class_flags & DEF_GLOBAL:
            scopes[name] = GLOBAL_EXPLICIT
            return
        if class_flags & DEF_BOUND and not class_flags & DEF_NONLOCAL:
            scopes[name] = GLOBAL_IMPLICIT
            return
    if bound is not None and name in bound:
        scopes[name] = FREE
        free[name] = None
        return
    scopes[name] = GLOBAL_IMPLICIT


def _is_free_in_any_child(entry, key):
    for child in entry.children:
        if (child.symbols.get(key, 0) >> SCOPE_OFF) & SCOPE_MASK == FREE:
            return True
    return False


def _inline_comprehension(ste, comp, scopes, comp_free, inlined_cells):
    removed = []
    is_class = ste.type == TYPE_CLASS
    for k, comp_flags in comp.symbols.items():
        if comp_flags & DEF_PARAM:
            continue
        scope = (comp_flags >> SCOPE_OFF) & SCOPE_MASK
        only_flags = comp_flags & ((1 << SCOPE_OFF) - 1)
        if scope == CELL or only_flags & DEF_COMP_CELL:
            inlined_cells[k] = None
        existing = ste.symbols.get(k)
        if scope == FREE and is_class and k in ('__class__', '__classdict__', '__conditional_annotations__'):
            scope = GLOBAL_IMPLICIT
            if not _is_free_in_any_child(comp, k):
                comp_free.pop(k, None)
            removed.append(k)
        if existing is None:
            ste.symbols[k] = only_flags
            scopes[k] = scope
            continue
        if scope == FREE and not is_class and comp_flags & USE and not existing & USE:
            ste.symbols[k] = existing | USE
        if existing & DEF_BOUND and not is_class and not _is_free_in_any_child(comp, k):
            comp_free.pop(k, None)
    for k in removed:
        del comp.symbols[k]


def _analyze_cells(scopes, free, inlined_cells):
    for name, scope in list(scopes.items()):
        if scope != LOCAL or (name not in free and name not in inlined_cells):
            continue
        scopes[name] = CELL
        free.pop(name, None)


def _drop_class_free(free):
    free.pop('__class__', None)
    free.pop('__classdict__', None)
    free.pop('__conditional_annotations__', None)


def _update_symbols(symbols, scopes, bound, free, inlined_cells, classflag):
    for name, flags in list(symbols.items()):
        if name in inlined_cells:
            flags |= DEF_COMP_CELL
        symbols[name] = flags | (scopes[name] << SCOPE_OFF)
    for name in free:
        flags = symbols.get(name)
        if flags is not None:
            if classflag:
                symbols[name] = flags | DEF_FREE_CLASS
            continue
        if bound is not None and name not in bound:
            continue
        symbols[name] = FREE << SCOPE_OFF
`;
