// The parts of CPython's `inspect.py` written in Python here: introspecting generators, wrappers, argument lists, and
// static attributes, binding arguments to signatures, and reading the program's source. The natives of inspect.ts
// provide the rest, such as `signature()` and the predicates.
export const INSPECT_SOURCE = String.raw`import sys
import types
import functools
import itertools
from collections import namedtuple

_POSITIONAL_ONLY = Parameter.POSITIONAL_ONLY
_POSITIONAL_OR_KEYWORD = Parameter.POSITIONAL_OR_KEYWORD
_VAR_POSITIONAL = Parameter.VAR_POSITIONAL
_KEYWORD_ONLY = Parameter.KEYWORD_ONLY
_VAR_KEYWORD = Parameter.VAR_KEYWORD


def iscode(object):
    """Return true if the object is a code object."""
    return isinstance(object, types.CodeType)


def isframe(object):
    """Return true if the object is a frame object."""
    return isinstance(object, types.FrameType)


def istraceback(object):
    """Return true if the object is a traceback."""
    return isinstance(object, types.TracebackType)


def isdatadescriptor(object):
    """Return true if the object is a data descriptor."""
    if isclass(object) or ismethod(object) or isfunction(object):
        return False
    tp = type(object)
    # The builtin data descriptors set attributes natively, without __set__ in their class dictionaries.
    if tp is property or tp.__name__ in ('member_descriptor', 'getset_descriptor'):
        return True
    return hasattr(tp, "__set__") or hasattr(tp, "__delete__")


def isabstract(object):
    """Return true if the object is an abstract base class (ABC)."""
    if not isinstance(object, type):
        return False
    if _has_abstract_methods(object):
        return True
    import abc
    if not issubclass(type(object), abc.ABCMeta):
        return False
    if hasattr(object, '__abstractmethods__'):
        return False
    for name, value in object.__dict__.items():
        if getattr(value, "__isabstractmethod__", False):
            return True
    for base in object.__bases__:
        for name in getattr(base, "__abstractmethods__", ()):
            value = getattr(object, name, None)
            if getattr(value, "__isabstractmethod__", False):
                return True
    return False


def _getmembers(object, predicate, getter):
    results = []
    processed = set()
    names = dir(object)
    if isclass(object):
        mro = getmro(object)
        try:
            for base in object.__bases__:
                for k, v in base.__dict__.items():
                    if isinstance(v, types.DynamicClassAttribute):
                        names.append(k)
        except AttributeError:
            pass
    else:
        mro = ()
    for key in names:
        try:
            value = getter(object, key)
            if key in processed:
                raise AttributeError
        except AttributeError:
            for base in mro:
                if key in base.__dict__:
                    value = base.__dict__[key]
                    break
            else:
                continue
        if not predicate or predicate(value):
            results.append((key, value))
        processed.add(key)
    results.sort(key=lambda pair: pair[0])
    return results


def getmembers_static(object, predicate=None):
    """Return all members of an object as (name, value) pairs sorted by name
    without triggering dynamic lookup via the descriptor protocol,
    __getattr__ or __getattribute__. Optionally, only return members that
    satisfy a given predicate."""
    return _getmembers(object, predicate, getattr_static)


def unwrap(func, *, stop=None):
    """Get the object wrapped by *func*."""
    f = func
    memo = {id(f): f}
    recursion_limit = sys.getrecursionlimit()
    while not isinstance(func, type) and hasattr(func, '__wrapped__'):
        if stop is not None and stop(func):
            break
        func = func.__wrapped__
        id_func = id(func)
        if (id_func in memo) or (len(memo) >= recursion_limit):
            raise ValueError('wrapper loop when unwrapping {!r}'.format(f))
        memo[id_func] = func
    return func


def indentsize(line):
    """Return the indent size, in spaces, at the start of a line of text."""
    expline = line.expandtabs()
    return len(expline) - len(expline.lstrip())


def findsource(object):
    """Return the entire source file and starting line number for an object."""
    return _findsource(object)


def getcomments(object):
    """Get lines of comments immediately preceding an object's source code.

    Returns None when source can't be found.
    """
    try:
        lines, lnum = findsource(object)
    except (OSError, TypeError):
        return None

    if ismodule(object):
        start = 0
        if lines and lines[0][:2] == '#!': start = 1
        while start < len(lines) and lines[start].strip() in ('', '#'):
            start = start + 1
        if start < len(lines) and lines[start][:1] == '#':
            comments = []
            end = start
            while end < len(lines) and lines[end][:1] == '#':
                comments.append(lines[end].expandtabs())
                end = end + 1
            return ''.join(comments)

    elif lnum > 0:
        indent = indentsize(lines[lnum])
        end = lnum - 1
        if end >= 0 and lines[end].lstrip()[:1] == '#' and \
            indentsize(lines[end]) == indent:
            comments = [lines[end].expandtabs().lstrip()]
            if end > 0:
                end = end - 1
                comment = lines[end].expandtabs().lstrip()
                while comment[:1] == '#' and indentsize(lines[end]) == indent:
                    comments[:0] = [comment]
                    end = end - 1
                    if end < 0: break
                    comment = lines[end].expandtabs().lstrip()
            while comments and comments[0].strip() == '#':
                comments[:1] = []
            while comments and comments[-1].strip() == '#':
                comments[-1:] = []
            return ''.join(comments)


def getblock(lines):
    """Extract the block of code at the top of the given list of lines."""
    return _getblock(lines)


def getsourcelines(object):
    """Return a list of source lines and starting line number for an object."""
    object = unwrap(object)
    lines, lnum = findsource(object)

    if istraceback(object):
        object = object.tb_frame

    if (ismodule(object) or
        (isframe(object) and object.f_code.co_name == "<module>")):
        return lines, 0
    else:
        return getblock(lines[lnum:]), lnum + 1


def getsource(object):
    """Return the text of the source code for an object."""
    lines, lnum = getsourcelines(object)
    return ''.join(lines)


def getmodule(object, _filename=None):
    """Return the module an object was defined in, or None if not found."""
    if ismodule(object):
        return object
    if hasattr(object, '__module__'):
        return sys.modules.get(object.__module__)
    return None


FullArgSpec = namedtuple('FullArgSpec',
    'args, varargs, varkw, defaults, kwonlyargs, kwonlydefaults, annotations')


def getfullargspec(func):
    """Get the names and default values of a callable object's parameters."""
    try:
        sig = signature(func.__func__ if ismethod(func) else func, follow_wrapped=False)
    except Exception as ex:
        raise TypeError('unsupported callable') from ex

    args = []
    varargs = None
    varkw = None
    posonlyargs = []
    kwonlyargs = []
    annotations = {}
    defaults = ()
    kwdefaults = {}

    if sig.return_annotation is not sig.empty:
        annotations['return'] = sig.return_annotation

    for param in sig.parameters.values():
        kind = param.kind
        name = param.name

        if kind is _POSITIONAL_ONLY:
            posonlyargs.append(name)
            if param.default is not param.empty:
                defaults += (param.default,)
        elif kind is _POSITIONAL_OR_KEYWORD:
            args.append(name)
            if param.default is not param.empty:
                defaults += (param.default,)
        elif kind is _VAR_POSITIONAL:
            varargs = name
        elif kind is _KEYWORD_ONLY:
            kwonlyargs.append(name)
            if param.default is not param.empty:
                kwdefaults[name] = param.default
        elif kind is _VAR_KEYWORD:
            varkw = name

        if param.annotation is not param.empty:
            annotations[name] = param.annotation

    if not kwdefaults:
        kwdefaults = None

    if not defaults:
        defaults = None

    return FullArgSpec(posonlyargs + args, varargs, varkw, defaults,
                       kwonlyargs, kwdefaults, annotations)


def _missing_arguments(f_name, argnames, pos, values):
    names = [repr(name) for name in argnames if name not in values]
    missing = len(names)
    if missing == 1:
        s = names[0]
    elif missing == 2:
        s = "{} and {}".format(*names)
    else:
        tail = ", {} and {}".format(*names[-2:])
        del names[-2:]
        s = ", ".join(names) + tail
    raise TypeError("%s() missing %i required %s argument%s: %s" %
                    (f_name, missing,
                      "positional" if pos else "keyword-only",
                      "" if missing == 1 else "s", s))


def _too_many(f_name, args, kwonly, varargs, defcount, given, values):
    atleast = len(args) - defcount
    kwonly_given = len([arg for arg in kwonly if arg in values])
    if varargs:
        plural = atleast != 1
        sig = "at least %d" % (atleast,)
    elif defcount:
        plural = True
        sig = "from %d to %d" % (atleast, len(args))
    else:
        plural = len(args) != 1
        sig = str(len(args))
    kwonly_sig = ""
    if kwonly_given:
        msg = " positional argument%s (and %d keyword-only argument%s)"
        kwonly_sig = (msg % ("s" if given != 1 else "", kwonly_given,
                             "s" if kwonly_given != 1 else ""))
    raise TypeError("%s() takes %s positional argument%s but %d%s %s given" %
            (f_name, sig, "s" if plural else "", given, kwonly_sig,
             "was" if given == 1 and not kwonly_given else "were"))


def getcallargs(func, /, *positional, **named):
    """Get the mapping of arguments to values."""
    spec = getfullargspec(func)
    args, varargs, varkw, defaults, kwonlyargs, kwonlydefaults, ann = spec
    f_name = func.__name__
    arg2value = {}

    if ismethod(func) and func.__self__ is not None:
        positional = (func.__self__,) + positional
    num_pos = len(positional)
    num_args = len(args)
    num_defaults = len(defaults) if defaults else 0

    n = min(num_pos, num_args)
    for i in range(n):
        arg2value[args[i]] = positional[i]
    if varargs:
        arg2value[varargs] = tuple(positional[n:])
    possible_kwargs = set(args + kwonlyargs)
    if varkw:
        arg2value[varkw] = {}
    for kw, value in named.items():
        if kw not in possible_kwargs:
            if not varkw:
                raise TypeError("%s() got an unexpected keyword argument %r" %
                                (f_name, kw))
            arg2value[varkw][kw] = value
            continue
        if kw in arg2value:
            raise TypeError("%s() got multiple values for argument %r" %
                            (f_name, kw))
        arg2value[kw] = value
    if num_pos > num_args and not varargs:
        _too_many(f_name, args, kwonlyargs, varargs, num_defaults,
                   num_pos, arg2value)
    if num_pos < num_args:
        req = args[:num_args - num_defaults]
        for arg in req:
            if arg not in arg2value:
                _missing_arguments(f_name, req, True, arg2value)
        for i, arg in enumerate(args[num_args - num_defaults:]):
            if arg not in arg2value:
                arg2value[arg] = defaults[i]
    missing = 0
    for kwarg in kwonlyargs:
        if kwarg not in arg2value:
            if kwonlydefaults and kwarg in kwonlydefaults:
                arg2value[kwarg] = kwonlydefaults[kwarg]
            else:
                missing += 1
    if missing:
        _missing_arguments(f_name, kwonlyargs, False, arg2value)
    return arg2value


def currentframe():
    """Return the frame of the caller or None if this is not possible."""
    return sys._getframe(1) if hasattr(sys, "_getframe") else None


_sentinel = object()


def _static_getmro(klass):
    return klass.__mro__


def _get_dunder_dict_of_class(klass):
    return klass.__dict__


def _check_instance(obj, attr):
    instance_dict = {}
    try:
        instance_dict = object.__getattribute__(obj, "__dict__")
    except AttributeError:
        pass
    return dict.get(instance_dict, attr, _sentinel)


def _check_class(klass, attr):
    for entry in _static_getmro(klass):
        if _shadowed_dict(type(entry)) is _sentinel and attr in entry.__dict__:
            return entry.__dict__[attr]
    return _sentinel


def _shadowed_dict(klass):
    for entry in _static_getmro(klass):
        dunder_dict = _get_dunder_dict_of_class(entry)
        if '__dict__' in dunder_dict:
            class_dict = dunder_dict['__dict__']
            if type(class_dict).__name__ != 'getset_descriptor':
                return class_dict
    return _sentinel


def getattr_static(obj, attr, default=_sentinel):
    """Retrieve attributes without triggering dynamic lookup via the
       descriptor protocol,  __getattr__ or __getattribute__."""
    instance_result = _sentinel

    objtype = type(obj)
    if type not in _static_getmro(objtype):
        klass = objtype
        dict_attr = _shadowed_dict(klass)
        if (dict_attr is _sentinel or
            type(dict_attr).__name__ == 'member_descriptor'):
            instance_result = _check_instance(obj, attr)
    else:
        klass = obj

    klass_result = _check_class(klass, attr)

    if instance_result is not _sentinel and klass_result is not _sentinel:
        if _check_class(type(klass_result), "__get__") is not _sentinel and (
            _check_class(type(klass_result), "__set__") is not _sentinel
            or _check_class(type(klass_result), "__delete__") is not _sentinel
        ):
            return klass_result

    if instance_result is not _sentinel:
        return instance_result
    if klass_result is not _sentinel:
        return klass_result

    if obj is klass:
        for entry in _static_getmro(type(klass)):
            if (
                _shadowed_dict(type(entry)) is _sentinel
                and attr in entry.__dict__
            ):
                return entry.__dict__[attr]
    if default is not _sentinel:
        return default
    raise AttributeError(attr)


GEN_CREATED = 'GEN_CREATED'
GEN_RUNNING = 'GEN_RUNNING'
GEN_SUSPENDED = 'GEN_SUSPENDED'
GEN_CLOSED = 'GEN_CLOSED'


def getgeneratorstate(generator):
    """Get current state of a generator-iterator."""
    if generator.gi_running:
        return GEN_RUNNING
    if generator.gi_suspended:
        return GEN_SUSPENDED
    if generator.gi_frame is None:
        return GEN_CLOSED
    return GEN_CREATED


def getgeneratorlocals(generator):
    """
    Get the mapping of generator local variables to their current values.

    A dict is returned, with the keys the local variable names and values the
    bound values."""

    if not isgenerator(generator):
        raise TypeError("{!r} is not a Python generator".format(generator))

    frame = getattr(generator, "gi_frame", None)
    if frame is not None:
        return generator.gi_frame.f_locals
    else:
        return {}


CORO_CREATED = 'CORO_CREATED'
CORO_RUNNING = 'CORO_RUNNING'
CORO_SUSPENDED = 'CORO_SUSPENDED'
CORO_CLOSED = 'CORO_CLOSED'


def getcoroutinestate(coroutine):
    """Get current state of a coroutine object."""
    if coroutine.cr_running:
        return CORO_RUNNING
    if coroutine.cr_suspended:
        return CORO_SUSPENDED
    if coroutine.cr_frame is None:
        return CORO_CLOSED
    return CORO_CREATED


def getcoroutinelocals(coroutine):
    """
    Get the mapping of coroutine local variables to their current values.

    A dict is returned, with the keys the local variable names and values the
    bound values."""
    frame = getattr(coroutine, "cr_frame", None)
    if frame is not None:
        return frame.f_locals
    else:
        return {}


AGEN_CREATED = 'AGEN_CREATED'
AGEN_RUNNING = 'AGEN_RUNNING'
AGEN_SUSPENDED = 'AGEN_SUSPENDED'
AGEN_CLOSED = 'AGEN_CLOSED'


def getasyncgenstate(agen):
    """Get current state of an asynchronous generator object."""
    if agen.ag_running:
        return AGEN_RUNNING
    if agen.ag_suspended:
        return AGEN_SUSPENDED
    if agen.ag_frame is None:
        return AGEN_CLOSED
    return AGEN_CREATED


def getasyncgenlocals(agen):
    """
    Get the mapping of asynchronous generator local variables to their current
    values.

    A dict is returned, with the keys the local variable names and values the
    bound values."""

    if not isasyncgen(agen):
        raise TypeError(f"{agen!r} is not a Python async generator")

    frame = getattr(agen, "ag_frame", None)
    if frame is not None:
        return agen.ag_frame.f_locals
    else:
        return {}


class BoundArguments:
    """Result of \x60Signature.bind\x60 call.  Holds the mapping of arguments
    to the function's parameters."""

    __slots__ = ('arguments', '_signature', '__weakref__')

    def __init__(self, signature, arguments):
        self.arguments = arguments
        self._signature = signature

    @property
    def signature(self):
        return self._signature

    @property
    def args(self):
        args = []
        for param_name, param in self._signature.parameters.items():
            if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                break

            try:
                arg = self.arguments[param_name]
            except KeyError:
                break
            else:
                if param.kind == _VAR_POSITIONAL:
                    args.extend(arg)
                else:
                    args.append(arg)

        return tuple(args)

    @property
    def kwargs(self):
        kwargs = {}
        kwargs_started = False
        for param_name, param in self._signature.parameters.items():
            if not kwargs_started:
                if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                    kwargs_started = True
                else:
                    if param_name not in self.arguments:
                        kwargs_started = True
                        continue

            if not kwargs_started:
                continue

            try:
                arg = self.arguments[param_name]
            except KeyError:
                pass
            else:
                if param.kind == _VAR_KEYWORD:
                    kwargs.update(arg)
                else:
                    kwargs[param_name] = arg

        return kwargs

    def apply_defaults(self):
        """Set default values for missing arguments."""
        arguments = self.arguments
        new_arguments = []
        for name, param in self._signature.parameters.items():
            try:
                new_arguments.append((name, arguments[name]))
            except KeyError:
                if param.default is not _empty:
                    val = param.default
                elif param.kind is _VAR_POSITIONAL:
                    val = ()
                elif param.kind is _VAR_KEYWORD:
                    val = {}
                else:
                    continue
                new_arguments.append((name, val))
        self.arguments = dict(new_arguments)

    def __eq__(self, other):
        if self is other:
            return True
        if not isinstance(other, BoundArguments):
            return NotImplemented
        return (self.signature == other.signature and
                self.arguments == other.arguments)

    def __setstate__(self, state):
        self._signature = state['_signature']
        self.arguments = state['arguments']

    def __getstate__(self):
        return {'_signature': self._signature, 'arguments': self.arguments}

    def __repr__(self):
        args = []
        for arg, value in self.arguments.items():
            args.append('{}={!r}'.format(arg, value))
        return '<{} ({})>'.format(self.__class__.__name__, ', '.join(args))


def _signature_bind(self, args, kwargs, *, partial=False):
    """Signature._bind, which Signature.bind and bind_partial call."""
    arguments = {}

    parameters = iter(self.parameters.values())
    parameters_ex = ()
    arg_vals = iter(args)

    pos_only_param_in_kwargs = []

    while True:
        try:
            arg_val = next(arg_vals)
        except StopIteration:
            try:
                param = next(parameters)
            except StopIteration:
                break
            else:
                if param.kind == _VAR_POSITIONAL:
                    break
                elif param.name in kwargs:
                    if param.kind == _POSITIONAL_ONLY:
                        if param.default is _empty:
                            msg = f'missing a required positional-only argument: {param.name!r}'
                            raise TypeError(msg)
                        pos_only_param_in_kwargs.append(param)
                        continue
                    parameters_ex = (param,)
                    break
                elif (param.kind == _VAR_KEYWORD or
                                            param.default is not _empty):
                    parameters_ex = (param,)
                    break
                else:
                    if partial:
                        parameters_ex = (param,)
                        break
                    else:
                        if param.kind == _KEYWORD_ONLY:
                            argtype = ' keyword-only'
                        else:
                            argtype = ''
                        msg = 'missing a required{argtype} argument: {arg!r}'
                        msg = msg.format(arg=param.name, argtype=argtype)
                        raise TypeError(msg) from None
        else:
            try:
                param = next(parameters)
            except StopIteration:
                raise TypeError('too many positional arguments') from None
            else:
                if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                    raise TypeError(
                        'too many positional arguments') from None

                if param.kind == _VAR_POSITIONAL:
                    values = [arg_val]
                    values.extend(arg_vals)
                    arguments[param.name] = tuple(values)
                    break

                if param.name in kwargs and param.kind != _POSITIONAL_ONLY:
                    raise TypeError(
                        'multiple values for argument {arg!r}'.format(
                            arg=param.name)) from None

                arguments[param.name] = arg_val

    kwargs_param = None
    for param in itertools.chain(parameters_ex, parameters):
        if param.kind == _VAR_KEYWORD:
            kwargs_param = param
            continue

        if param.kind == _VAR_POSITIONAL:
            continue

        param_name = param.name
        try:
            arg_val = kwargs.pop(param_name)
        except KeyError:
            if (not partial and param.kind != _VAR_POSITIONAL and
                                                param.default is _empty):
                raise TypeError('missing a required argument: {arg!r}'. \
                                format(arg=param_name)) from None

        else:
            arguments[param_name] = arg_val

    if kwargs:
        if kwargs_param is not None:
            arguments[kwargs_param.name] = kwargs
        elif pos_only_param_in_kwargs:
            raise TypeError(
                'got some positional-only arguments passed as '
                'keyword arguments: {arg!r}'.format(
                    arg=', '.join(
                        param.name
                        for param in pos_only_param_in_kwargs
                    ),
                ),
            )
        else:
            raise TypeError(
                'got an unexpected keyword argument {arg!r}'.format(
                    arg=next(iter(kwargs))))

    return BoundArguments(self, arguments)
`;
