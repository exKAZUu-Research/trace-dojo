// CPython 3.14's `Lib/inspect.py`'s `Signature._bind`, `BoundArguments`, and `_signature_get_partial`, which the native `inspect.Signature` calls.
export const INSPECT_BIND_SOURCE =
  String.raw`import functools
import itertools
from collections import OrderedDict
from inspect import Parameter, _empty

_POSITIONAL_ONLY = Parameter.POSITIONAL_ONLY
_POSITIONAL_OR_KEYWORD = Parameter.POSITIONAL_OR_KEYWORD
_VAR_POSITIONAL = Parameter.VAR_POSITIONAL
_KEYWORD_ONLY = Parameter.KEYWORD_ONLY
_VAR_KEYWORD = Parameter.VAR_KEYWORD
_PLACEHOLDER = getattr(functools, 'Placeholder', object())


def _signature_get_partial(wrapped_sig, partial, extra_args=()):
    """Private helper to calculate how 'wrapped_sig' signature will
    look like after applying a 'functools.partial' object (or alike)
    on it.
    """

    old_params = wrapped_sig.parameters
    new_params = OrderedDict(old_params.items())

    partial_args = partial.args or ()
    partial_keywords = partial.keywords or {}

    if extra_args:
        partial_args = extra_args + partial_args

    try:
        ba = wrapped_sig.bind_partial(*partial_args, **partial_keywords)
    except TypeError as ex:
        msg = 'partial object {!r} has incorrect arguments'.format(partial)
        raise ValueError(msg) from ex


    transform_to_kwonly = False
    for param_name, param in old_params.items():
        try:
            arg_value = ba.arguments[param_name]
        except KeyError:
            pass
        else:
            if param.kind is _POSITIONAL_ONLY:
                # If positional-only parameter is bound by partial,
                # it effectively disappears from the signature
                # However, if it is a Placeholder it is not removed
                # And also looses default value
                if arg_value is _PLACEHOLDER:
                    new_params[param_name] = param.replace(default=_empty)
                else:
                    new_params.pop(param_name)
                continue

            if param.kind is _POSITIONAL_OR_KEYWORD:
                if param_name in partial_keywords:
                    # This means that this parameter, and all parameters
                    # after it should be keyword-only (and var-positional
                    # should be removed). Here's why. Consider the following
                    # function:
                    #     foo(a, b, *args, c):
                    #         pass
                    #
                    # "partial(foo, a='spam')" will have the following
                    # signature: "(*, a='spam', b, c)". Because attempting
                    # to call that partial with "(10, 20)" arguments will
                    # raise a TypeError, saying that "a" argument received
                    # multiple values.
                    transform_to_kwonly = True
                    # Set the new default value
                    new_params[param_name] = param.replace(default=arg_value)
                else:
                    # was passed as a positional argument
                    # Do not pop if it is a Placeholder
                    #   also change kind to positional only
                    #   and remove default
                    if arg_value is _PLACEHOLDER:
                        new_param = param.replace(
                            kind=_POSITIONAL_ONLY,
                            default=_empty
                        )
                        new_params[param_name] = new_param
                    else:
                        new_params.pop(param_name)
                    continue

            if param.kind is _KEYWORD_ONLY:
                # Set the new default value
                new_params[param_name] = param.replace(default=arg_value)

        if transform_to_kwonly:
            assert param.kind is not _POSITIONAL_ONLY

            if param.kind is _POSITIONAL_OR_KEYWORD:
                new_param = new_params[param_name].replace(kind=_KEYWORD_ONLY)
                new_params[param_name] = new_param
                new_params.move_to_end(param_name)
            elif param.kind in (_KEYWORD_ONLY, _VAR_KEYWORD):
                new_params.move_to_end(param_name)
            elif param.kind is _VAR_POSITIONAL:
                new_params.pop(param.name)

    return wrapped_sig.replace(parameters=new_params.values())



class BoundArguments:
    """Result of ` +
  '`' +
  String.raw`Signature.bind` +
  '`' +
  String.raw` call.  Holds the mapping of arguments
    to the function's parameters.

    Has the following public attributes:

    * arguments : dict
        An ordered mutable mapping of parameters' names to arguments' values.
        Does not contain arguments' default values.
    * signature : Signature
        The Signature object that created this instance.
    * args : tuple
        Tuple of positional arguments values.
    * kwargs : dict
        Dict of keyword arguments values.
    """

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
                # We're done here. Other arguments
                # will be mapped in 'BoundArguments.kwargs'
                break
            else:
                if param.kind == _VAR_POSITIONAL:
                    # *args
                    args.extend(arg)
                else:
                    # plain argument
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
                    # **kwargs
                    kwargs.update(arg)
                else:
                    # plain keyword argument
                    kwargs[param_name] = arg

        return kwargs

    def apply_defaults(self):
        """Set default values for missing arguments.

        For variable-positional arguments (*args) the default is an
        empty tuple.

        For variable-keyword arguments (**kwargs) the default is an
        empty dict.
        """
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
                    # This BoundArguments was likely produced by
                    # Signature.bind_partial().
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


BoundArguments.__module__ = 'inspect'


def _bind(self, args, kwargs, *, partial=False):
    """Private method. Don't use directly."""

    arguments = {}

    parameters = iter(self.parameters.values())
    parameters_ex = ()
    arg_vals = iter(args)

    pos_only_param_in_kwargs = []

    while True:
        # Let's iterate through the positional arguments and corresponding
        # parameters
        try:
            arg_val = next(arg_vals)
        except StopIteration:
            # No more positional arguments
            try:
                param = next(parameters)
            except StopIteration:
                # No more parameters. That's it. Just need to check that
                # we have no ` +
  '`' +
  String.raw`kwargs` +
  '`' +
  String.raw` after this while loop
                break
            else:
                if param.kind == _VAR_POSITIONAL:
                    # That's OK, just empty *args.  Let's start parsing
                    # kwargs
                    break
                elif param.name in kwargs:
                    if param.kind == _POSITIONAL_ONLY:
                        if param.default is _empty:
                            msg = f'missing a required positional-only argument: {param.name!r}'
                            raise TypeError(msg)
                        # Raise a TypeError once we are sure there is no
                        # **kwargs param later.
                        pos_only_param_in_kwargs.append(param)
                        continue
                    parameters_ex = (param,)
                    break
                elif (param.kind == _VAR_KEYWORD or
                                            param.default is not _empty):
                    # That's fine too - we have a default value for this
                    # parameter.  So, lets start parsing ` +
  '`' +
  String.raw`kwargs` +
  '`' +
  String.raw`, starting
                    # with the current parameter
                    parameters_ex = (param,)
                    break
                else:
                    # No default, not VAR_KEYWORD, not VAR_POSITIONAL,
                    # not in ` +
  '`' +
  String.raw`kwargs` +
  '`' +
  String.raw`
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
            # We have a positional argument to process
            try:
                param = next(parameters)
            except StopIteration:
                raise TypeError('too many positional arguments') from None
            else:
                if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                    # Looks like we have no parameter for this positional
                    # argument
                    raise TypeError(
                        'too many positional arguments') from None

                if param.kind == _VAR_POSITIONAL:
                    # We have an '*args'-like argument, let's fill it with
                    # all positional arguments we have left and move on to
                    # the next phase
                    values = [arg_val]
                    values.extend(arg_vals)
                    arguments[param.name] = tuple(values)
                    break

                if param.name in kwargs and param.kind != _POSITIONAL_ONLY:
                    raise TypeError(
                        'multiple values for argument {arg!r}'.format(
                            arg=param.name)) from None

                arguments[param.name] = arg_val

    # Now, we iterate through the remaining parameters to process
    # keyword arguments
    kwargs_param = None
    for param in itertools.chain(parameters_ex, parameters):
        if param.kind == _VAR_KEYWORD:
            # Memorize that we have a '**kwargs'-like parameter
            kwargs_param = param
            continue

        if param.kind == _VAR_POSITIONAL:
            # Named arguments don't refer to '*args'-like parameters.
            # We only arrive here if the positional arguments ended
            # before reaching the last parameter before *args.
            continue

        param_name = param.name
        try:
            arg_val = kwargs.pop(param_name)
        except KeyError:
            # We have no value for this parameter.  It's fine though,
            # if it has a default value, or it is an '*args'-like
            # parameter, left alone by the processing of positional
            # arguments.
            if (not partial and param.kind != _VAR_POSITIONAL and
                                                param.default is _empty):
                raise TypeError('missing a required argument: {arg!r}'. \
                                format(arg=param_name)) from None

        else:
            arguments[param_name] = arg_val

    if kwargs:
        if kwargs_param is not None:
            # Process our '**kwargs'-like parameter
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
