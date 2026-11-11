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
    _check_namespace(object, 'inspect.getmembers()')
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
    while not isinstance(func, type) and not _is_unavailable(func) and hasattr(func, '__wrapped__'):
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


# The names CPython's inspect.py defines as below.
from annotationlib import Format, ForwardRef
from annotationlib import get_annotations
import token
import tokenize
from keyword import iskeyword
from operator import attrgetter
from collections import OrderedDict
from weakref import ref as make_weakref
import enum
import os

# importlib.machinery.all_suffixes() of the reference CPython.
_ALL_SUFFIXES = ['.py', '.pyc', '.cpython-314-darwin.so', '.abi3.so', '.so']

CO_OPTIMIZED = 1
CO_NEWLOCALS = 2
CO_VARARGS = 4
CO_VARKEYWORDS = 8
CO_NESTED = 16
CO_GENERATOR = 32
CO_NOFREE = 64
CO_COROUTINE = 128
CO_ITERABLE_COROUTINE = 256
CO_ASYNC_GENERATOR = 512
CO_HAS_DOCSTRING = 67108864
CO_METHOD = 134217728

TPFLAGS_IS_ABSTRACT = 1 << 20

if hasattr(types, 'MemberDescriptorType'):
    # CPython and equivalent
    def ismemberdescriptor(object):
        """Return true if the object is a member descriptor.

        Member descriptors are specialized descriptors defined in extension
        modules."""
        return isinstance(object, types.MemberDescriptorType)
else:
    # Other implementations
    def ismemberdescriptor(object):
        """Return true if the object is a member descriptor.

        Member descriptors are specialized descriptors defined in extension
        modules."""
        return False

if hasattr(types, 'GetSetDescriptorType'):
    # CPython and equivalent
    def isgetsetdescriptor(object):
        """Return true if the object is a getset descriptor.

        getset descriptors are specialized descriptors defined in extension
        modules."""
        return isinstance(object, types.GetSetDescriptorType)
else:
    # Other implementations
    def isgetsetdescriptor(object):
        """Return true if the object is a getset descriptor.

        getset descriptors are specialized descriptors defined in extension
        modules."""
        return False

def ismethodwrapper(object):
    """Return true if the object is a method wrapper."""
    return isinstance(object, types.MethodWrapperType)

def ispackage(object):
    """Return true if the object is a package."""
    return ismodule(object) and hasattr(object, "__path__")

_is_coroutine_mark = object()

def _has_coroutine_mark(f):
    while ismethod(f):
        f = f.__func__
    f = functools._unwrap_partial(f)
    return getattr(f, "_is_coroutine_marker", None) is _is_coroutine_mark

def markcoroutinefunction(func):
    """
    Decorator to ensure callable is recognised as a coroutine function.
    """
    if hasattr(func, '__func__'):
        func = func.__func__
    func._is_coroutine_marker = _is_coroutine_mark
    return func

Attribute = namedtuple('Attribute', 'name kind defining_class object')

def classify_class_attrs(cls):
    """Return list of attribute-descriptor tuples.

    For each name in dir(cls), the return list contains a 4-tuple
    with these elements:

        0. The name (a string).

        1. The kind of attribute this is, one of these strings:
               'class method'    created via classmethod()
               'static method'   created via staticmethod()
               'property'        created via property()
               'method'          any other flavor of method or descriptor
               'data'            not a method

        2. The class which defined this attribute (a class).

        3. The object as obtained by calling getattr; if this fails, or if the
           resulting object does not live anywhere in the class' mro (including
           metaclasses) then the object is looked up in the defining class's
           dict (found by walking the mro).

    If one of the items in dir(cls) is stored in the metaclass it will now
    be discovered and not have None be listed as the class in which it was
    defined.  Any items whose home class cannot be discovered are skipped.
    """

    mro = getmro(cls)
    metamro = getmro(type(cls)) # for attributes stored in the metaclass
    metamro = tuple(cls for cls in metamro if cls not in (type, object))
    class_bases = (cls,) + mro
    all_bases = class_bases + metamro
    names = dir(cls)
    # :dd any DynamicClassAttributes to the list of names;
    # this may result in duplicate entries if, for example, a virtual
    # attribute with the same name as a DynamicClassAttribute exists.
    for base in mro:
        for k, v in base.__dict__.items():
            if isinstance(v, types.DynamicClassAttribute) and v.fget is not None:
                names.append(k)
    result = []
    processed = set()

    for name in names:
        # Get the object associated with the name, and where it was defined.
        # Normal objects will be looked up with both getattr and directly in
        # its class' dict (in case getattr fails [bug #1785], and also to look
        # for a docstring).
        # For DynamicClassAttributes on the second pass we only look in the
        # class's dict.
        #
        # Getting an obj from the __dict__ sometimes reveals more than
        # using getattr.  Static and class methods are dramatic examples.
        homecls = None
        get_obj = None
        dict_obj = None
        if name not in processed:
            try:
                if name == '__dict__':
                    raise Exception("__dict__ is special, don't want the proxy")
                get_obj = getattr(cls, name)
            except Exception:
                pass
            else:
                homecls = getattr(get_obj, "__objclass__", homecls)
                if homecls not in class_bases:
                    # if the resulting object does not live somewhere in the
                    # mro, drop it and search the mro manually
                    homecls = None
                    last_cls = None
                    # first look in the classes
                    for srch_cls in class_bases:
                        srch_obj = getattr(srch_cls, name, None)
                        if srch_obj is get_obj:
                            last_cls = srch_cls
                    # then check the metaclasses
                    for srch_cls in metamro:
                        try:
                            srch_obj = srch_cls.__getattr__(cls, name)
                        except AttributeError:
                            continue
                        if srch_obj is get_obj:
                            last_cls = srch_cls
                    if last_cls is not None:
                        homecls = last_cls
        for base in all_bases:
            if name in base.__dict__:
                dict_obj = base.__dict__[name]
                if homecls not in metamro:
                    homecls = base
                break
        if homecls is None:
            # unable to locate the attribute anywhere, most likely due to
            # buggy custom __dir__; discard and move on
            continue
        obj = get_obj if get_obj is not None else dict_obj
        # Classify the object or its descriptor.
        if isinstance(dict_obj, (staticmethod, types.BuiltinMethodType)):
            kind = "static method"
            obj = dict_obj
        elif isinstance(dict_obj, (classmethod, types.ClassMethodDescriptorType)):
            kind = "class method"
            obj = dict_obj
        elif isinstance(dict_obj, property):
            kind = "property"
            obj = dict_obj
        elif isroutine(obj):
            kind = "method"
        else:
            kind = "data"
        result.append(Attribute(name, kind, homecls, obj))
        processed.add(name)
    return result

def getmodulename(path):
    """Return the module name for a given file, or None."""
    fname = os.path.basename(path)
    # Check for paths that look like an actual module file
    suffixes = [(-len(suffix), suffix)
                    for suffix in _ALL_SUFFIXES]
    suffixes.sort() # try longest suffixes first, in case they overlap
    for neglen, suffix in suffixes:
        if fname.endswith(suffix):
            return fname[:neglen]
    return None

class ClassFoundException(Exception):
    pass

class EndOfBlock(Exception): pass

class BlockFinder:
    """Provide a tokeneater() method to detect the end of a code block."""
    def __init__(self):
        self.indent = 0
        self.singleline = False
        self.started = False
        self.passline = False
        self.indecorator = False
        self.last = 1
        self.body_col0 = None

    def tokeneater(self, type, token, srowcol, erowcol, line):
        if not self.started and not self.indecorator:
            if type in (tokenize.INDENT, tokenize.COMMENT, tokenize.NL):
                pass
            elif token == "async":
                pass
            # skip any decorators
            elif token == "@":
                self.indecorator = True
            else:
                # For "def" and "class" scan to the end of the block.
                # For "lambda" and generator expression scan to
                # the end of the logical line.
                self.singleline = token not in ("def", "class")
                self.started = True
            self.passline = True    # skip to the end of the line
        elif type == tokenize.NEWLINE:
            self.passline = False   # stop skipping when a NEWLINE is seen
            self.last = srowcol[0]
            if self.singleline:
                raise EndOfBlock
            # hitting a NEWLINE when in a decorator without args
            # ends the decorator
            if self.indecorator:
                self.indecorator = False
        elif self.passline:
            pass
        elif type == tokenize.INDENT:
            if self.body_col0 is None and self.started:
                self.body_col0 = erowcol[1]
            self.indent = self.indent + 1
            self.passline = True
        elif type == tokenize.DEDENT:
            self.indent = self.indent - 1
            # the end of matching indent/dedent pairs end a block
            # (note that this only works for "def"/"class" blocks,
            #  not e.g. for "if: else:" or "try: finally:" blocks)
            if self.indent <= 0:
                raise EndOfBlock
        elif type == tokenize.COMMENT:
            if self.body_col0 is not None and srowcol[1] >= self.body_col0:
                # Include comments if indented at least as much as the block
                self.last = srowcol[0]
        elif self.indent == 0 and type not in (tokenize.COMMENT, tokenize.NL):
            # any other token on the same indentation level end the previous
            # block as well, except the pseudo-tokens COMMENT and NL.
            raise EndOfBlock

def walktree(classes, children, parent):
    """Recursive helper function for getclasstree()."""
    results = []
    classes.sort(key=attrgetter('__module__', '__name__'))
    for c in classes:
        results.append((c, c.__bases__))
        if c in children:
            results.append(walktree(children[c], children, c))
    return results

def getclasstree(classes, unique=False):
    """Arrange the given list of classes into a hierarchy of nested lists.

    Where a nested list appears, it contains classes derived from the class
    whose entry immediately precedes the list.  Each entry is a 2-tuple
    containing a class and a tuple of its base classes.  If the 'unique'
    argument is true, exactly one entry appears in the returned structure
    for each class in the given list.  Otherwise, classes using multiple
    inheritance and their descendants will appear multiple times."""
    children = {}
    roots = []
    for c in classes:
        if c.__bases__:
            for parent in c.__bases__:
                if parent not in children:
                    children[parent] = []
                if c not in children[parent]:
                    children[parent].append(c)
                if unique and parent in classes: break
        elif c not in roots:
            roots.append(c)
    for parent in children:
        if parent not in classes:
            roots.append(parent)
    return walktree(roots, children, None)

Arguments = namedtuple('Arguments', 'args, varargs, varkw')

def getargs(co):
    """Get information about the arguments accepted by a code object.

    Three things are returned: (args, varargs, varkw), where
    'args' is the list of argument names. Keyword-only arguments are
    appended. 'varargs' and 'varkw' are the names of the * and **
    arguments or None."""
    if not iscode(co):
        raise TypeError('{!r} is not a code object'.format(co))

    names = co.co_varnames
    nargs = co.co_argcount
    nkwargs = co.co_kwonlyargcount
    args = list(names[:nargs])
    kwonlyargs = list(names[nargs:nargs+nkwargs])

    nargs += nkwargs
    varargs = None
    if co.co_flags & CO_VARARGS:
        varargs = co.co_varnames[nargs]
        nargs = nargs + 1
    varkw = None
    if co.co_flags & CO_VARKEYWORDS:
        varkw = co.co_varnames[nargs]
    return Arguments(args + kwonlyargs, varargs, varkw)

ArgInfo = namedtuple('ArgInfo', 'args varargs keywords locals')

def getargvalues(frame):
    """Get information about arguments passed into a particular frame.

    A tuple of four things is returned: (args, varargs, varkw, locals).
    'args' is a list of the argument names.
    'varargs' and 'varkw' are the names of the * and ** arguments or None.
    'locals' is the locals dictionary of the given frame."""
    args, varargs, varkw = getargs(frame.f_code)
    return ArgInfo(args, varargs, varkw, frame.f_locals)

def formatannotationrelativeto(object):
    module = getattr(object, '__module__', None)
    def _formatannotation(annotation):
        return formatannotation(annotation, module)
    return _formatannotation

def formatargvalues(args, varargs, varkw, locals,
                    formatarg=str,
                    formatvarargs=lambda name: '*' + name,
                    formatvarkw=lambda name: '**' + name,
                    formatvalue=lambda value: '=' + repr(value)):
    """Format an argument spec from the 4 values returned by getargvalues.

    The first four arguments are (args, varargs, varkw, locals).  The
    next four arguments are the corresponding optional formatting functions
    that are called to turn names and values into strings.  The ninth
    argument is an optional function to format the sequence of arguments."""
    def convert(name, locals=locals,
                formatarg=formatarg, formatvalue=formatvalue):
        return formatarg(name) + formatvalue(locals[name])
    specs = []
    for i in range(len(args)):
        specs.append(convert(args[i]))
    if varargs:
        specs.append(formatvarargs(varargs) + formatvalue(locals[varargs]))
    if varkw:
        specs.append(formatvarkw(varkw) + formatvalue(locals[varkw]))
    return '(' + ', '.join(specs) + ')'

ClosureVars = namedtuple('ClosureVars', 'nonlocals globals builtins unbound')

_Traceback = namedtuple('_Traceback', 'filename lineno function code_context index')

class Traceback(_Traceback):
    def __new__(cls, filename, lineno, function, code_context, index, *, positions=None):
        instance = super().__new__(cls, filename, lineno, function, code_context, index)
        instance.positions = positions
        return instance

    def __repr__(self):
        return ('Traceback(filename={!r}, lineno={!r}, function={!r}, '
               'code_context={!r}, index={!r}, positions={!r})'.format(
                self.filename, self.lineno, self.function, self.code_context,
                self.index, self.positions))

def getlineno(frame):
    """Get the line number from a frame object, allowing for optimization."""
    # FrameType.f_lineno is now a descriptor that grovels co_lnotab
    return frame.f_lineno

_FrameInfo = namedtuple('_FrameInfo', ('frame',) + Traceback._fields)

class FrameInfo(_FrameInfo):
    def __new__(cls, frame, filename, lineno, function, code_context, index, *, positions=None):
        instance = super().__new__(cls, frame, filename, lineno, function, code_context, index)
        instance.positions = positions
        return instance

    def __repr__(self):
        return ('FrameInfo(frame={!r}, filename={!r}, lineno={!r}, function={!r}, '
               'code_context={!r}, index={!r}, positions={!r})'.format(
                self.frame, self.filename, self.lineno, self.function,
                self.code_context, self.index, self.positions))

class BufferFlags(enum.IntFlag):
    SIMPLE = 0x0
    WRITABLE = 0x1
    FORMAT = 0x4
    ND = 0x8
    STRIDES = 0x10 | ND
    C_CONTIGUOUS = 0x20 | STRIDES
    F_CONTIGUOUS = 0x40 | STRIDES
    ANY_CONTIGUOUS = 0x80 | STRIDES
    INDIRECT = 0x100 | STRIDES
    CONTIG = ND | WRITABLE
    CONTIG_RO = ND
    STRIDED = STRIDES | WRITABLE
    STRIDED_RO = STRIDES
    RECORDS = STRIDES | WRITABLE | FORMAT
    RECORDS_RO = STRIDES | FORMAT
    FULL = INDIRECT | WRITABLE | FORMAT
    FULL_RO = INDIRECT | FORMAT
    READ = 0x100
    WRITE = 0x200



_iscoroutinefunction = iscoroutinefunction


def iscoroutinefunction(obj):
    """Return true if the object is a coroutine function.

    Coroutine functions are normally defined with "async def" syntax, but may
    be marked via markcoroutinefunction.
    """
    return _iscoroutinefunction(obj) or _has_coroutine_mark(obj)
`;
