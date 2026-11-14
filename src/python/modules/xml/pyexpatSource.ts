/**
 * CPython's `pyexpat` module, which CPython writes in C (`Modules/pyexpat.c`), in Python over the natives of this
 * grader's expat: the parser object's attributes and their checks, the conversion of each event's arguments, the
 * buffering of character data, and the messages.
 */
export const PYEXPAT_SOURCE = String.raw`
"""Python wrapper for Expat parser."""

from operator import index as _index
import pyexpat.errors as errors
import pyexpat.model as model

EXPAT_VERSION = 'expat_2.9.0'
version_info = (2, 9, 0)
native_encoding = 'UTF-8'
features = [('sizeof(XML_Char)', 1), ('sizeof(XML_LChar)', 1), ('XML_DTD', 0), ('XML_CONTEXT_BYTES', 1024),
            ('XML_NS', 0), ('XML_BLAP_MAX_AMP', 100), ('XML_BLAP_ACT_THRES', 8388608), ('XML_GE', 0),
            ('XML_AT_MAX_AMP', 100), ('XML_AT_ACT_THRES', 67108864)]
XML_PARAM_ENTITY_PARSING_NEVER = 0
XML_PARAM_ENTITY_PARSING_UNLESS_STANDALONE = 1
XML_PARAM_ENTITY_PARSING_ALWAYS = 2


class ExpatError(Exception):
    __module__ = 'xml.parsers.expat'


error = ExpatError

_HANDLERS = {
    'StartElementHandler': 'startElement',
    'EndElementHandler': 'endElement',
    'ProcessingInstructionHandler': 'processingInstruction',
    'CharacterDataHandler': 'characterData',
    'UnparsedEntityDeclHandler': 'unparsedEntityDecl',
    'NotationDeclHandler': 'notationDecl',
    'StartNamespaceDeclHandler': 'startNamespaceDecl',
    'EndNamespaceDeclHandler': 'endNamespaceDecl',
    'CommentHandler': 'comment',
    'StartCdataSectionHandler': 'startCdataSection',
    'EndCdataSectionHandler': 'endCdataSection',
    'DefaultHandler': 'default',
    'DefaultHandlerExpand': 'default',
    'NotStandaloneHandler': 'notStandalone',
    'ExternalEntityRefHandler': 'externalEntityRef',
    'StartDoctypeDeclHandler': 'startDoctypeDecl',
    'EndDoctypeDeclHandler': 'endDoctypeDecl',
    'EntityDeclHandler': 'entityDecl',
    'XmlDeclHandler': 'xmlDecl',
    'ElementDeclHandler': 'elementDecl',
    'AttlistDeclHandler': 'attlistDecl',
    'SkippedEntityHandler': 'skippedEntity',
}

_READONLY = ('CurrentLineNumber', 'CurrentColumnNumber', 'CurrentByteIndex', 'ErrorCode', 'ErrorLineNumber',
             'ErrorColumnNumber', 'ErrorByteIndex', 'buffer_used')

_MISSING = object()


def ErrorString(*args, **kwargs):
    """Returns string error for given number."""
    code = _index(_one('pyexpat.ErrorString', args, kwargs))
    if 0 < code < len(_messages):
        return _messages[code]
    return None


def _no_new_attribute(name):
    raise AttributeError(
        f"'pyexpat.xmlparser' object has no attribute '{name}' and no __dict__ for setting new attributes")


def _one(name, args, kwargs):
    if kwargs:
        raise TypeError(f'{name}() takes no keyword arguments')
    if len(args) != 1:
        raise TypeError(f'{name}() takes exactly one argument ({len(args)} given)')
    return args[0]


def _none(name, args, kwargs):
    if kwargs:
        raise TypeError(f'{name}() takes no keyword arguments')
    if args:
        raise TypeError(f'{name}() takes no arguments ({len(args)} given)')


def _positional(name, args, kwargs, low, high, defaults=()):
    count = len(args)
    if count < low:
        exactly = 'exactly' if low == high else 'at least'
        raise TypeError(f'{name}() takes {exactly} {low} positional argument{"" if low == 1 else "s"} ({count} given)')
    if kwargs:
        raise TypeError(f"{name}() got an unexpected keyword argument '{next(iter(kwargs))}'")
    if count > high:
        raise TypeError(f'{name}() takes at most {high} argument{"" if high == 1 else "s"} ({count} given)')
    return args + defaults[count - low:]


def ParserCreate(*args, **kwargs):
    """Return a new XML parser object."""
    if len(args) + len(kwargs) > 3:
        raise TypeError(f'ParserCreate() takes at most 3 arguments ({len(args) + len(kwargs)} given)')
    names = ('encoding', 'namespace_separator', 'intern')
    values = dict(zip(names, args))
    for key, value in kwargs.items():
        if key not in names:
            raise TypeError(f"ParserCreate() got an unexpected keyword argument '{key}'")
        if key in values:
            raise TypeError(f"argument for ParserCreate() given by name ('{key}') and position ({names.index(key) + 1})")
        values[key] = value
    encoding = values.get('encoding')
    namespace_separator = values.get('namespace_separator')
    intern = values.get('intern', _MISSING)
    if encoding is not None and not isinstance(encoding, str):
        raise TypeError(f"ParserCreate() argument 'encoding' must be str or None, not {type(encoding).__name__}")
    if namespace_separator is not None:
        if not isinstance(namespace_separator, str):
            raise TypeError("ParserCreate() argument 'namespace_separator' must be str or None, not "
                            f"{type(namespace_separator).__name__}")
        if len(namespace_separator) > 1:
            raise ValueError('namespace_separator must be at most one character, omitted, or None')
    if intern is _MISSING:
        intern = {}
    elif intern is not None and not isinstance(intern, dict):
        raise TypeError('intern must be a dictionary')
    parser = object.__new__(XMLParserType)
    parser._init(encoding, namespace_separator, intern)
    return parser


class xmlparser:
    """XML parser"""

    __slots__ = ('_engine', '_handlers', '_intern', '_buffer', '_buffer_size', '_ordered', '_specified',
                 '_triplets', '_in_callback')

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create 'pyexpat.xmlparser' instances")

    def _init(self, encoding, separator, intern):
        init = object.__setattr__
        init(self, '_engine', _create(separator, encoding, _encoding_table))
        init(self, '_handlers', dict.fromkeys(_HANDLERS))
        init(self, '_intern', intern)
        init(self, '_buffer', None)
        init(self, '_buffer_size', 8192)
        init(self, '_ordered', False)
        init(self, '_specified', False)
        init(self, '_triplets', False)
        init(self, '_in_callback', False)

    def __getattr__(self, name):
        if name in _HANDLERS:
            return self._handlers[name]
        raise AttributeError(f"'pyexpat.xmlparser' object has no attribute '{name}'")

    def __setattr__(self, name, value):
        if name in _HANDLERS:
            self._set_handler(name, value)
        elif name == 'buffer_text':
            self._set_buffer_text(value)
        elif name == 'buffer_size':
            self._set_buffer_size(value)
        elif name == 'ordered_attributes':
            object.__setattr__(self, '_ordered', bool(value))
        elif name == 'specified_attributes':
            object.__setattr__(self, '_specified', bool(value))
        elif name == 'namespace_prefixes':
            object.__setattr__(self, '_triplets', bool(value))
            _option(self._engine, 'triplets', bool(value))
        elif name == 'intern':
            raise AttributeError('readonly attribute')
        elif name in _READONLY:
            raise AttributeError(f"attribute '{name}' of 'pyexpat.xmlparser' objects is not writable")
        else:
            _no_new_attribute(name)

    def __delattr__(self, name):
        if name in _HANDLERS or name in ('buffer_text', 'buffer_size', 'ordered_attributes',
                                         'specified_attributes', 'namespace_prefixes'):
            raise RuntimeError('Cannot delete attribute')
        object.__delattr__(self, name)

    def _set_handler(self, name, value):
        if name == 'CharacterDataHandler' and self._buffer is not None:
            self._flush()
        self._handlers[name] = value
        if name.startswith('Default'):
            other = 'DefaultHandlerExpand' if name == 'DefaultHandler' else 'DefaultHandler'
            self._handlers[other] = None
            _option(self._engine, 'expand', name == 'DefaultHandlerExpand')
        _install(self._engine, _HANDLERS[name], None if value is None else getattr(self, '_' + _HANDLERS[name]))

    def _set_buffer_text(self, value):
        if value:
            if self._buffer is None:
                object.__setattr__(self, '_buffer', [])
        elif self._buffer is not None:
            self._flush()
            object.__setattr__(self, '_buffer', None)

    def _set_buffer_size(self, value):
        if not isinstance(value, int):
            raise TypeError('buffer_size must be an integer')
        if value <= 0:
            raise ValueError('buffer_size must be greater than zero')
        if value > 2147483647:
            raise ValueError('buffer_size must not be greater than 2147483647')
        if self._buffer is not None:
            self._flush()
        object.__setattr__(self, '_buffer_size', value)

    buffer_text = property(lambda self: self._buffer is not None)
    buffer_size = property(lambda self: self._buffer_size)
    buffer_used = property(lambda self: 0 if self._buffer is None else _utf8_length(''.join(self._buffer)))
    ordered_attributes = property(lambda self: self._ordered)
    specified_attributes = property(lambda self: self._specified)
    namespace_prefixes = property(lambda self: self._triplets)
    intern = property(lambda self: self._intern)
    ErrorCode = property(lambda self: _info(self._engine, 'ErrorCode'))
    ErrorLineNumber = property(lambda self: _info(self._engine, 'ErrorLineNumber'))
    ErrorColumnNumber = property(lambda self: _info(self._engine, 'ErrorColumnNumber'))
    ErrorByteIndex = property(lambda self: _info(self._engine, 'ErrorByteIndex'))
    CurrentLineNumber = property(lambda self: _info(self._engine, 'CurrentLineNumber'))
    CurrentColumnNumber = property(lambda self: _info(self._engine, 'CurrentColumnNumber'))
    CurrentByteIndex = property(lambda self: _info(self._engine, 'CurrentByteIndex'))

    def Parse(self, *args, **kwargs):
        """Parse XML data.

  'isfinal' should be true at end of input.
"""
        data, isfinal = _positional('Parse', args, kwargs, 1, 2, (False,))
        if not isinstance(data, str):
            data = _bytes_like(data)
        return self._parse(data, bool(isfinal), None)

    def _parse(self, data, isfinal, request):
        object.__setattr__(self, '_in_callback', True)
        try:
            failure = _parse(self._engine, data, isfinal, request)
        finally:
            object.__setattr__(self, '_in_callback', False)
        if failure is not None:
            self._raise(failure)
        self._flush()
        return 1

    def _raise(self, failure):
        code, line, column = failure
        err = ExpatError(f'{_messages[code]}: line {line}, column {column}')
        err.code = code
        err.lineno = line
        err.offset = column
        raise err

    def ParseFile(self, *args, **kwargs):
        """Parse XML data from file-like object."""
        file, = _positional('ParseFile', args, kwargs, 1, 1)
        try:
            read = file.read
        except AttributeError:
            raise TypeError("argument must have 'read' attribute") from None
        while True:
            data = read(2048)
            if not isinstance(data, (bytes, bytearray)):
                raise TypeError(f'read() did not return a bytes object (type={type(data).__name__})')
            if len(data) > 2048:
                raise ValueError(f'read() returned too much data: 2048 bytes requested, {len(data)} returned')
            self._parse(bytes(data), len(data) == 0, 2048)
            if len(data) == 0:
                return 1

    def SetBase(self, *args, **kwargs):
        """Set the base URL for the parser."""
        base = _one('xmlparser.SetBase', args, kwargs)
        if not isinstance(base, str):
            raise TypeError(f'SetBase() argument must be str, not {type(base).__name__}')
        _option(self._engine, 'base', base)

    def GetBase(self, *args, **kwargs):
        """Return base URL string for the parser."""
        _none('xmlparser.GetBase', args, kwargs)
        return _info(self._engine, 'base')

    def GetInputContext(self, *args, **kwargs):
        """Return the untranslated text of the input that caused the current event.

If the event was generated by a large amount of text (such as a start tag
for an element with many attributes), not all of the text may be available.
"""
        _none('xmlparser.GetInputContext', args, kwargs)
        if not self._in_callback:
            return None
        return _info(self._engine, 'context')

    def ExternalEntityParserCreate(self, *args, **kwargs):
        """Create a parser for parsing an external entity based on the information passed to the ExternalEntityRefHandler."""
        _positional('ExternalEntityParserCreate', args, kwargs, 1, 2, (None,))
        _unsupported('外部実体のパーサー（ExternalEntityParserCreate()）')

    def SetParamEntityParsing(self, *args, **kwargs):
        """Controls parsing of parameter entities (including the external DTD subset).

Possible flag values are XML_PARAM_ENTITY_PARSING_NEVER,
XML_PARAM_ENTITY_PARSING_UNLESS_STANDALONE and
XML_PARAM_ENTITY_PARSING_ALWAYS. Returns true if setting the flag
was successful.
"""
        flag = _index(_one('xmlparser.SetParamEntityParsing', args, kwargs))
        _option(self._engine, 'paramEntityParsing', flag)
        return 1

    def UseForeignDTD(self, *args, **kwargs):
        """Allows the application to provide an artificial external subset if one is not specified as part of the document instance.

This readily allows the use of a 'default' document type controlled by the
application, while still getting the advantage of providing document type
information to the parser. 'flag' defaults to True if not provided.
"""
        flag, = _positional('UseForeignDTD', args, kwargs, 0, 1, (True,))
        failure = _option(self._engine, 'foreignDTD', bool(flag))
        if failure is not None:
            self._raise(failure)

    def GetReparseDeferralEnabled(self, *args, **kwargs):
        """Retrieve reparse deferral enabled status; always returns false with Expat <2.6.0."""
        _none('xmlparser.GetReparseDeferralEnabled', args, kwargs)
        return _info(self._engine, 'reparseDeferral')

    def SetReparseDeferralEnabled(self, *args, **kwargs):
        """Enable/Disable reparse deferral; enabled by default with Expat >=2.6.0."""
        enabled = _one('xmlparser.SetReparseDeferralEnabled', args, kwargs)
        _option(self._engine, 'reparseDeferral', bool(enabled))

    def SetBillionLaughsAttackProtectionActivationThreshold(self, threshold, /):
        """Sets the number of output bytes needed to activate protection against billion laughs attacks."""
        return None

    def SetBillionLaughsAttackProtectionMaximumAmplification(self, max_factor, /):
        """Sets the maximum tolerated amplification factor for protection against billion laughs attacks."""
        return None

    def SetAllocTrackerActivationThreshold(self, threshold, /):
        """Sets the number of allocated bytes of dynamic memory needed to activate protection against disproportionate use of RAM."""
        return None

    def SetAllocTrackerMaximumAmplification(self, max_factor, /):
        """Sets the maximum amplification factor between direct input and bytes of dynamic memory allocated."""
        return None

    # Events ------------------------------------------------------------------------------------------------------

    def _flush(self):
        buffer = self._buffer
        if buffer:
            data = ''.join(buffer)
            buffer.clear()
            self._call('CharacterDataHandler', data)

    def _call(self, name, *args):
        handler = self._handlers[name]
        if handler is None:
            return None
        return handler(*args)

    def _event(self, name, *args):
        if self._handlers[name] is None:
            return None
        if self._buffer is not None:
            self._flush()
        return self._call(name, *args)

    def _name(self, name):
        intern = self._intern
        if intern is None:
            return name
        return intern.setdefault(name, name)

    def _startElement(self, name, attributes, specified):
        if self._handlers['StartElementHandler'] is None:
            return
        if self._specified:
            attributes = attributes[:specified]
        for index in range(0, len(attributes), 2):
            attributes[index] = self._name(attributes[index])
        if not self._ordered:
            attributes = dict(zip(attributes[::2], attributes[1::2]))
        self._event('StartElementHandler', self._name(name), attributes)

    def _endElement(self, name):
        self._event('EndElementHandler', self._name(name))

    def _characterData(self, data):
        if self._buffer is None:
            self._call('CharacterDataHandler', data)
            return
        length = _utf8_length(data)
        if self.buffer_used + length > self._buffer_size:
            self._flush()
            if self._handlers['CharacterDataHandler'] is None:
                return
        if length > self._buffer_size:
            self._call('CharacterDataHandler', data)
        else:
            self._buffer.append(data)

    def _processingInstruction(self, target, data):
        self._event('ProcessingInstructionHandler', target, data)

    def _comment(self, data):
        self._event('CommentHandler', data)

    def _startCdataSection(self):
        self._event('StartCdataSectionHandler')

    def _endCdataSection(self):
        self._event('EndCdataSectionHandler')

    def _default(self, data):
        name = 'DefaultHandler' if self._handlers['DefaultHandler'] is not None else 'DefaultHandlerExpand'
        self._event(name, data)

    def _xmlDecl(self, version, encoding, standalone):
        self._event('XmlDeclHandler', version, encoding, standalone)

    def _startDoctypeDecl(self, name, system_id, public_id, has_internal_subset):
        self._event('StartDoctypeDeclHandler', name, system_id, public_id, has_internal_subset)

    def _endDoctypeDecl(self):
        self._event('EndDoctypeDeclHandler')

    def _entityDecl(self, *args):
        self._event('EntityDeclHandler', *args)

    def _unparsedEntityDecl(self, *args):
        self._event('UnparsedEntityDeclHandler', *args)

    def _notationDecl(self, *args):
        self._event('NotationDeclHandler', *args)

    def _elementDecl(self, name, model):
        self._event('ElementDeclHandler', name, model)

    def _attlistDecl(self, *args):
        self._event('AttlistDeclHandler', *args)

    def _startNamespaceDecl(self, prefix, uri):
        self._event('StartNamespaceDeclHandler', prefix, uri)

    def _endNamespaceDecl(self, prefix):
        self._event('EndNamespaceDeclHandler', prefix)

    def _skippedEntity(self, name, is_parameter_entity):
        self._event('SkippedEntityHandler', name, is_parameter_entity)

    def _notStandalone(self):
        return _index(self._event('NotStandaloneHandler'))

    def _externalEntityRef(self, context, base, system_id, public_id):
        return _index(self._event('ExternalEntityRefHandler', context, base, system_id, public_id))


_c_type_name(xmlparser, 'pyexpat.xmlparser')
XMLParserType = xmlparser
del xmlparser


def _encoding_table(name):
    text = bytes(range(256)).decode(name, 'replace')
    if len(text) != 256:
        raise ValueError('multi-byte encodings are not supported')
    return [-1 if char == '�' else ord(char) for char in text]


def _utf8_length(text):
    return len(text.encode('utf-8', 'surrogatepass'))


_messages = [None] + [errors.messages[code] for code in range(1, 45)]
expat_CAPI = _capsule()
`;

/** `pyexpat.model`. */
export const MODEL_SOURCE = String.raw`
"""Constants used to interpret content model information."""

XML_CTYPE_EMPTY = 1
XML_CTYPE_ANY = 2
XML_CTYPE_MIXED = 3
XML_CTYPE_NAME = 4
XML_CTYPE_CHOICE = 5
XML_CTYPE_SEQ = 6
XML_CQUANT_NONE = 0
XML_CQUANT_OPT = 1
XML_CQUANT_REP = 2
XML_CQUANT_PLUS = 3
`;
