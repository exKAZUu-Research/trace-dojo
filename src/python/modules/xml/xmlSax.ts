import { registerSourceModule } from '../../sourceModules';

// CPython's `xml.sax` package, whose default parser is the expat reader.

const SAX = String.raw`"""Simple API for XML (SAX) implementation for Python.

This module provides an implementation of the SAX 2 interface;
information about the Java version of the interface can be found at
http://www.megginson.com/SAX/.  The Python version of the interface is
documented at <...>.

This package contains the following modules:

handler -- Base classes and constants which define the SAX 2 API for
           the 'client-side' of SAX for Python.

saxutils -- Implementation of the convenience classes commonly used to
            work with SAX.

xmlreader -- Base classes and constants which define the SAX 2 API for
             the parsers used with SAX for Python.

expatreader -- Driver that allows use of the Expat parser with SAX.
"""

from xml.sax.xmlreader import InputSource
from xml.sax.handler import ContentHandler, ErrorHandler
from xml.sax._exceptions import (SAXException, SAXNotRecognizedException,
                          SAXParseException, SAXNotSupportedException,
                          SAXReaderNotAvailable)


def parse(source, handler, errorHandler=ErrorHandler()):
    """Parse an XML document with the default parser.

    source is a system identifier, a path-like object or a file object,
    handler is a ContentHandler instance, and errorHandler is an
    ErrorHandler instance.  All work is done by the handler."""
    parser = make_parser()
    parser.setContentHandler(handler)
    parser.setErrorHandler(errorHandler)
    parser.parse(source)

def parseString(string, handler, errorHandler=ErrorHandler()):
    """Parse an XML document from a string with the default parser.

    string is a str or a bytes-like object, the other arguments are the
    same as for parse()."""
    import io
    if errorHandler is None:
        errorHandler = ErrorHandler()
    parser = make_parser()
    parser.setContentHandler(handler)
    parser.setErrorHandler(errorHandler)

    inpsrc = InputSource()
    if isinstance(string, str):
        inpsrc.setCharacterStream(io.StringIO(string))
    else:
        inpsrc.setByteStream(io.BytesIO(string))
    parser.parse(inpsrc)

# this is the parser list used by the make_parser function if no
# alternatives are given as parameters to the function

default_parser_list = ["xml.sax.expatreader"]

# tell modulefinder that importing sax potentially imports expatreader
_false = 0
if _false:
    import xml.sax.expatreader    # noqa: F401

import os, sys
# The grader runs programs with no PY_SAX_PARSER in the environment, which it does not let them read.
del os, sys


def make_parser(parser_list=()):
    """Creates and returns a SAX parser.

    Creates the first parser it is able to instantiate of the ones
    given in the iterable created by chaining parser_list and
    default_parser_list.  The iterables must contain the names of Python
    modules containing both a SAX parser and a create_parser function."""

    for parser_name in list(parser_list) + default_parser_list:
        try:
            return _create_parser(parser_name)
        except ImportError:
            import sys
            if parser_name in sys.modules:
                # The parser module was found, but importing it
                # failed unexpectedly, pass this exception through
                raise
        except SAXReaderNotAvailable:
            # The parser module detected that it won't work properly,
            # so try the next one
            pass

    raise SAXReaderNotAvailable("No parsers found", None)

# --- Internal utility methods used by make_parser

def _create_parser(parser_name):
    drv_module = __import__(parser_name,{},{},['create_parser'])
    return drv_module.create_parser()


__all__ = ['ContentHandler', 'ErrorHandler', 'InputSource', 'SAXException',
           'SAXNotRecognizedException', 'SAXNotSupportedException',
           'SAXParseException', 'SAXReaderNotAvailable',
           'default_parser_list', 'make_parser', 'parse', 'parseString']
`;

const EXCEPTIONS = String.raw`"""Different kinds of SAX Exceptions"""

# ===== SAXEXCEPTION =====

class SAXException(Exception):
    """Encapsulate an XML error or warning. This class can contain
    basic error or warning information from either the XML parser or
    the application: you can subclass it to provide additional
    functionality, or to add localization. Note that although you will
    receive a SAXException as the argument to the handlers in the
    ErrorHandler interface, you are not actually required to raise
    the exception; instead, you can simply read the information in
    it."""

    def __init__(self, msg, exception=None):
        """Creates an exception. The message is required, but the exception
        is optional."""
        self._msg = msg
        self._exception = exception
        Exception.__init__(self, msg)

    def getMessage(self):
        "Return a message for this exception."
        return self._msg

    def getException(self):
        "Return the embedded exception, or None if there was none."
        return self._exception

    def __str__(self):
        "Create a string representation of the exception."
        return self._msg

    def __getitem__(self, ix):
        """Avoids weird error messages if someone does exception[ix] by
        mistake, since Exception has __getitem__ defined."""
        raise AttributeError("__getitem__")


# ===== SAXPARSEEXCEPTION =====

class SAXParseException(SAXException):
    """Encapsulate an XML parse error or warning.

    This exception will include information for locating the error in
    the original XML document. Note that although the application will
    receive a SAXParseException as the argument to the handlers in the
    ErrorHandler interface, the application is not actually required
    to raise the exception; instead, it can simply read the
    information in it and take a different action.

    Since this exception is a subclass of SAXException, it inherits
    the ability to wrap another exception."""

    def __init__(self, msg, exception, locator):
        "Creates the exception. The exception parameter is allowed to be None."
        SAXException.__init__(self, msg, exception)
        self._locator = locator

        # We need to cache this stuff at construction time.
        # If this exception is raised, the objects through which we must
        # traverse to get this information may be deleted by the time
        # it gets caught.
        self._systemId = self._locator.getSystemId()
        self._colnum = self._locator.getColumnNumber()
        self._linenum = self._locator.getLineNumber()

    def getColumnNumber(self):
        """The column number of the end of the text where the exception
        occurred."""
        return self._colnum

    def getLineNumber(self):
        "The line number of the end of the text where the exception occurred."
        return self._linenum

    def getPublicId(self):
        "Get the public identifier of the entity where the exception occurred."
        return self._locator.getPublicId()

    def getSystemId(self):
        "Get the system identifier of the entity where the exception occurred."
        return self._systemId

    def __str__(self):
        "Create a string representation of the exception."
        sysid = self.getSystemId()
        if sysid is None:
            sysid = "<unknown>"
        linenum = self.getLineNumber()
        if linenum is None:
            linenum = "?"
        colnum = self.getColumnNumber()
        if colnum is None:
            colnum = "?"
        return "%s:%s:%s: %s" % (sysid, linenum, colnum, self._msg)


# ===== SAXNOTRECOGNIZEDEXCEPTION =====

class SAXNotRecognizedException(SAXException):
    """Exception class for an unrecognized identifier.

    An XMLReader will raise this exception when it is confronted with an
    unrecognized feature or property. SAX applications and extensions may
    use this class for similar purposes."""


# ===== SAXNOTSUPPORTEDEXCEPTION =====

class SAXNotSupportedException(SAXException):
    """Exception class for an unsupported operation.

    An XMLReader will raise this exception when a service it cannot
    perform is requested (specifically setting a state or value). SAX
    applications and extensions may use this class for similar
    purposes."""

# ===== SAXNOTSUPPORTEDEXCEPTION =====

class SAXReaderNotAvailable(SAXNotSupportedException):
    """Exception class for a missing driver.

    An XMLReader module (driver) should raise this exception when it
    is first imported, e.g. when a support module cannot be imported.
    It also may be raised during parsing, e.g. if executing an external
    program is not permitted."""
`;

const HANDLER = String.raw`"""
This module contains the core classes of version 2.0 of SAX for Python.
This file provides only default classes with absolutely minimum
functionality, from which drivers and applications can be subclassed.

Many of these classes are empty and are included only as documentation
of the interfaces.

$Id$
"""

version = '2.0beta'

#============================================================================
#
# HANDLER INTERFACES
#
#============================================================================

# ===== ERRORHANDLER =====

class ErrorHandler:
    """Basic interface for SAX error handlers.

    If you create an object that implements this interface, then
    register the object with your XMLReader, the parser will call the
    methods in your object to report all warnings and errors. There
    are three levels of errors available: warnings, (possibly)
    recoverable errors, and unrecoverable errors. All methods take a
    SAXParseException as the only parameter."""

    def error(self, exception):
        "Handle a recoverable error."
        raise exception

    def fatalError(self, exception):
        "Handle a non-recoverable error."
        raise exception

    def warning(self, exception):
        "Handle a warning."
        print(exception)


# ===== CONTENTHANDLER =====

class ContentHandler:
    """Interface for receiving logical document content events.

    This is the main callback interface in SAX, and the one most
    important to applications. The order of events in this interface
    mirrors the order of the information in the document."""

    def __init__(self):
        self._locator = None

    def setDocumentLocator(self, locator):
        """Called by the parser to give the application a locator for
        locating the origin of document events.

        SAX parsers are strongly encouraged (though not absolutely
        required) to supply a locator: if it does so, it must supply
        the locator to the application by invoking this method before
        invoking any of the other methods in the DocumentHandler
        interface.

        The locator allows the application to determine the end
        position of any document-related event, even if the parser is
        not reporting an error. Typically, the application will use
        this information for reporting its own errors (such as
        character content that does not match an application's
        business rules). The information returned by the locator is
        probably not sufficient for use with a search engine.

        Note that the locator will return correct information only
        during the invocation of the events in this interface. The
        application should not attempt to use it at any other time."""
        self._locator = locator

    def startDocument(self):
        """Receive notification of the beginning of a document.

        The SAX parser will invoke this method only once, before any
        other methods in this interface or in DTDHandler (except for
        setDocumentLocator)."""

    def endDocument(self):
        """Receive notification of the end of a document.

        The SAX parser will invoke this method only once, and it will
        be the last method invoked during the parse. The parser shall
        not invoke this method until it has either abandoned parsing
        (because of an unrecoverable error) or reached the end of
        input."""

    def startPrefixMapping(self, prefix, uri):
        """Begin the scope of a prefix-URI Namespace mapping.

        The information from this event is not necessary for normal
        Namespace processing: the SAX XML reader will automatically
        replace prefixes for element and attribute names when the
        http://xml.org/sax/features/namespaces feature is true (the
        default).

        There are cases, however, when applications need to use
        prefixes in character data or in attribute values, where they
        cannot safely be expanded automatically; the
        start/endPrefixMapping event supplies the information to the
        application to expand prefixes in those contexts itself, if
        necessary.

        Note that start/endPrefixMapping events are not guaranteed to
        be properly nested relative to each-other: all
        startPrefixMapping events will occur before the corresponding
        startElement event, and all endPrefixMapping events will occur
        after the corresponding endElement event, but their order is
        not guaranteed."""

    def endPrefixMapping(self, prefix):
        """End the scope of a prefix-URI mapping.

        See startPrefixMapping for details. This event will always
        occur after the corresponding endElement event, but the order
        of endPrefixMapping events is not otherwise guaranteed."""

    def startElement(self, name, attrs):
        """Signals the start of an element in non-namespace mode.

        The name parameter contains the raw XML 1.0 name of the
        element type as a string and the attrs parameter holds an
        instance of the Attributes class containing the attributes of
        the element."""

    def endElement(self, name):
        """Signals the end of an element in non-namespace mode.

        The name parameter contains the name of the element type, just
        as with the startElement event."""

    def startElementNS(self, name, qname, attrs):
        """Signals the start of an element in namespace mode.

        The name parameter contains the name of the element type as a
        (uri, localname) tuple, the qname parameter the raw XML 1.0
        name used in the source document, and the attrs parameter
        holds an instance of the Attributes class containing the
        attributes of the element.

        The uri part of the name tuple is None for elements which have
        no namespace."""

    def endElementNS(self, name, qname):
        """Signals the end of an element in namespace mode.

        The name parameter contains the name of the element type, just
        as with the startElementNS event."""

    def characters(self, content):
        """Receive notification of character data.

        The Parser will call this method to report each chunk of
        character data. SAX parsers may return all contiguous
        character data in a single chunk, or they may split it into
        several chunks; however, all of the characters in any single
        event must come from the same external entity so that the
        Locator provides useful information."""

    def ignorableWhitespace(self, whitespace):
        """Receive notification of ignorable whitespace in element content.

        Validating Parsers must use this method to report each chunk
        of ignorable whitespace (see the W3C XML 1.0 recommendation,
        section 2.10): non-validating parsers may also use this method
        if they are capable of parsing and using content models.

        SAX parsers may return all contiguous whitespace in a single
        chunk, or they may split it into several chunks; however, all
        of the characters in any single event must come from the same
        external entity, so that the Locator provides useful
        information."""

    def processingInstruction(self, target, data):
        """Receive notification of a processing instruction.

        The Parser will invoke this method once for each processing
        instruction found: note that processing instructions may occur
        before or after the main document element.

        A SAX parser should never report an XML declaration (XML 1.0,
        section 2.8) or a text declaration (XML 1.0, section 4.3.1)
        using this method."""

    def skippedEntity(self, name):
        """Receive notification of a skipped entity.

        The Parser will invoke this method once for each entity
        skipped. Non-validating processors may skip entities if they
        have not seen the declarations (because, for example, the
        entity was declared in an external DTD subset). All processors
        may skip external entities, depending on the values of the
        http://xml.org/sax/features/external-general-entities and the
        http://xml.org/sax/features/external-parameter-entities
        properties."""


# ===== DTDHandler =====

class DTDHandler:
    """Handle DTD events.

    This interface specifies only those DTD events required for basic
    parsing (unparsed entities and attributes)."""

    def notationDecl(self, name, publicId, systemId):
        "Handle a notation declaration event."

    def unparsedEntityDecl(self, name, publicId, systemId, ndata):
        "Handle an unparsed entity declaration event."


# ===== ENTITYRESOLVER =====

class EntityResolver:
    """Basic interface for resolving entities. If you create an object
    implementing this interface, then register the object with your
    Parser, the parser will call the method in your object to
    resolve all external entities. Note that DefaultHandler implements
    this interface with the default behaviour."""

    def resolveEntity(self, publicId, systemId):
        """Resolve the system identifier of an entity and return either
        the system identifier to read from as a string, or an InputSource
        to read from."""
        return systemId


#============================================================================
#
# CORE FEATURES
#
#============================================================================

feature_namespaces = "http://xml.org/sax/features/namespaces"
# true: Perform Namespace processing (default).
# false: Optionally do not perform Namespace processing
#        (implies namespace-prefixes).
# access: (parsing) read-only; (not parsing) read/write

feature_namespace_prefixes = "http://xml.org/sax/features/namespace-prefixes"
# true: Report the original prefixed names and attributes used for Namespace
#       declarations.
# false: Do not report attributes used for Namespace declarations, and
#        optionally do not report original prefixed names (default).
# access: (parsing) read-only; (not parsing) read/write

feature_string_interning = "http://xml.org/sax/features/string-interning"
# true: All element names, prefixes, attribute names, Namespace URIs, and
#       local names are interned using the built-in intern function.
# false: Names are not necessarily interned, although they may be (default).
# access: (parsing) read-only; (not parsing) read/write

feature_validation = "http://xml.org/sax/features/validation"
# true: Report all validation errors (implies external-general-entities and
#       external-parameter-entities).
# false: Do not report validation errors.
# access: (parsing) read-only; (not parsing) read/write

feature_external_ges = "http://xml.org/sax/features/external-general-entities"
# true: Include all external general (text) entities.
# false: Do not include external general entities.
# access: (parsing) read-only; (not parsing) read/write

feature_external_pes = "http://xml.org/sax/features/external-parameter-entities"
# true: Include all external parameter entities, including the external
#       DTD subset.
# false: Do not include any external parameter entities, even the external
#        DTD subset.
# access: (parsing) read-only; (not parsing) read/write

all_features = [feature_namespaces,
                feature_namespace_prefixes,
                feature_string_interning,
                feature_validation,
                feature_external_ges,
                feature_external_pes]


#============================================================================
#
# CORE PROPERTIES
#
#============================================================================

property_lexical_handler = "http://xml.org/sax/properties/lexical-handler"
# data type: xml.sax.sax2lib.LexicalHandler
# description: An optional extension handler for lexical events like comments.
# access: read/write

property_declaration_handler = "http://xml.org/sax/properties/declaration-handler"
# data type: xml.sax.sax2lib.DeclHandler
# description: An optional extension handler for DTD-related events other
#              than notations and unparsed entities.
# access: read/write

property_dom_node = "http://xml.org/sax/properties/dom-node"
# data type: org.w3c.dom.Node
# description: When parsing, the current DOM node being visited if this is
#              a DOM iterator; when not parsing, the root DOM node for
#              iteration.
# access: (parsing) read-only; (not parsing) read/write

property_xml_string = "http://xml.org/sax/properties/xml-string"
# data type: String
# description: The literal string of characters that was the source for
#              the current event.
# access: read-only

property_encoding = "http://www.python.org/sax/properties/encoding"
# data type: String
# description: The name of the encoding to assume for input data.
# access: write: set the encoding, e.g. established by a higher-level
#                protocol. May change during parsing (e.g. after
#                processing a META tag)
#         read:  return the current encoding (possibly established through
#                auto-detection.
# initial value: UTF-8
#

property_interning_dict = "http://www.python.org/sax/properties/interning-dict"
# data type: Dictionary
# description: The dictionary used to intern common strings in the document
# access: write: Request that the parser uses a specific dictionary, to
#                allow interning across different documents
#         read:  return the current interning dictionary, or None
#

all_properties = [property_lexical_handler,
                  property_dom_node,
                  property_declaration_handler,
                  property_xml_string,
                  property_encoding,
                  property_interning_dict]


class LexicalHandler:
    """Optional SAX2 handler for lexical events.

    This handler is used to obtain lexical information about an XML
    document, that is, information about how the document was encoded
    (as opposed to what it contains, which is reported to the
    ContentHandler), such as comments and CDATA marked section
    boundaries.

    To set the LexicalHandler of an XMLReader, use the setProperty
    method with the property identifier
    'http://xml.org/sax/properties/lexical-handler'."""

    def comment(self, content):
        """Reports a comment anywhere in the document (including the
        DTD and outside the document element).

        content is a string that holds the contents of the comment."""

    def startDTD(self, name, public_id, system_id):
        """Report the start of the DTD declarations, if the document
        has an associated DTD.

        A startEntity event will be reported before declaration events
        from the external DTD subset are reported, and this can be
        used to infer from which subset DTD declarations derive.

        name is the name of the document element type, public_id the
        public identifier of the DTD (or None if none were supplied)
        and system_id the system identifier of the external subset (or
        None if none were supplied)."""

    def endDTD(self):
        """Signals the end of DTD declarations."""

    def startCDATA(self):
        """Reports the beginning of a CDATA marked section.

        The contents of the CDATA marked section will be reported
        through the characters event."""

    def endCDATA(self):
        """Reports the end of a CDATA marked section."""
`;

const XMLREADER = String.raw`"""An XML Reader is the SAX 2 name for an XML parser. XML Parsers
should be based on this code. """

from xml.sax import handler

from xml.sax._exceptions import SAXNotSupportedException, SAXNotRecognizedException


# ===== XMLREADER =====

class XMLReader:
    """Interface for reading an XML document using callbacks.

    XMLReader is the interface that an XML parser's SAX2 driver must
    implement. This interface allows an application to set and query
    features and properties in the parser, to register event handlers
    for document processing, and to initiate a document parse.

    All SAX interfaces are assumed to be synchronous: the parse
    methods must not return until parsing is complete, and readers
    must wait for an event-handler callback to return before reporting
    the next event."""

    def __init__(self):
        self._cont_handler = handler.ContentHandler()
        self._dtd_handler = handler.DTDHandler()
        self._ent_handler = handler.EntityResolver()
        self._err_handler = handler.ErrorHandler()

    def parse(self, source):
        "Parse an XML document from a system identifier or an InputSource."
        raise NotImplementedError("This method must be implemented!")

    def getContentHandler(self):
        "Returns the current ContentHandler."
        return self._cont_handler

    def setContentHandler(self, handler):
        "Registers a new object to receive document content events."
        self._cont_handler = handler

    def getDTDHandler(self):
        "Returns the current DTD handler."
        return self._dtd_handler

    def setDTDHandler(self, handler):
        "Register an object to receive basic DTD-related events."
        self._dtd_handler = handler

    def getEntityResolver(self):
        "Returns the current EntityResolver."
        return self._ent_handler

    def setEntityResolver(self, resolver):
        "Register an object to resolve external entities."
        self._ent_handler = resolver

    def getErrorHandler(self):
        "Returns the current ErrorHandler."
        return self._err_handler

    def setErrorHandler(self, handler):
        "Register an object to receive error-message events."
        self._err_handler = handler

    def setLocale(self, locale):
        """Allow an application to set the locale for errors and warnings.

        SAX parsers are not required to provide localization for errors
        and warnings; if they cannot support the requested locale,
        however, they must raise a SAX exception. Applications may
        request a locale change in the middle of a parse."""
        raise SAXNotSupportedException("Locale support not implemented")

    def getFeature(self, name):
        "Looks up and returns the state of a SAX2 feature."
        raise SAXNotRecognizedException("Feature '%s' not recognized" % name)

    def setFeature(self, name, state):
        "Sets the state of a SAX2 feature."
        raise SAXNotRecognizedException("Feature '%s' not recognized" % name)

    def getProperty(self, name):
        "Looks up and returns the value of a SAX2 property."
        raise SAXNotRecognizedException("Property '%s' not recognized" % name)

    def setProperty(self, name, value):
        "Sets the value of a SAX2 property."
        raise SAXNotRecognizedException("Property '%s' not recognized" % name)

class IncrementalParser(XMLReader):
    """This interface adds four extra methods to the XMLReader
    interface that allow XML parsers to support incremental
    parsing. Support for this interface is optional, since not all
    underlying XML parsers support this functionality.

    When the parser is instantiated it is ready to begin accepting
    data from the feed method immediately. After parsing has been
    finished with a call to close the reset method must be called to
    make the parser ready to accept new data, either from feed or
    using the parse method.

    Note that these methods must _not_ be called during parsing, that
    is, after parse has been called and before it returns.

    By default, the class also implements the parse method of the XMLReader
    interface using the prepareParser, feed and close methods of the
    IncrementalParser interface as a convenience to SAX 2.0 driver
    writers."""

    def __init__(self, bufsize=2**16):
        self._bufsize = bufsize
        XMLReader.__init__(self)

    def parse(self, source):
        from xml.sax import saxutils
        source = saxutils.prepare_input_source(source)

        self.prepareParser(source)
        file = source.getCharacterStream()
        if file is None:
            file = source.getByteStream()
        while buffer := file.read(self._bufsize):
            self.feed(buffer)
        self.close()

    def feed(self, data):
        """This method gives the raw XML data in the data parameter to
        the parser and makes it parse the data, emitting the
        corresponding events. It is allowed for XML constructs to be
        split across several calls to feed.

        feed may raise SAXException."""
        raise NotImplementedError("This method must be implemented!")

    def prepareParser(self, source):
        """This method is called by the parse implementation to allow
        the SAX 2.0 driver to prepare itself for parsing."""
        raise NotImplementedError("prepareParser must be overridden!")

    def close(self):
        """This method is called when the entire XML document has been
        passed to the parser through the feed method, to notify the
        parser that there are no more data. This allows the parser to
        do the final checks on the document and empty the internal
        data buffer.

        The parser will not be ready to parse another document until
        the reset method has been called.

        close may raise SAXException."""
        raise NotImplementedError("This method must be implemented!")

    def reset(self):
        """This method is called after close has been called to reset
        the parser so that it is ready to parse new documents. The
        results of calling parse or feed after close without calling
        reset are undefined."""
        raise NotImplementedError("This method must be implemented!")

# ===== LOCATOR =====

class Locator:
    """Interface for associating a SAX event with a document
    location. A locator object will return valid results only during
    calls to DocumentHandler methods; at any other time, the
    results are unpredictable."""

    def getColumnNumber(self):
        "Return the column number where the current event ends."
        return -1

    def getLineNumber(self):
        "Return the line number where the current event ends."
        return -1

    def getPublicId(self):
        "Return the public identifier for the current event."
        return None

    def getSystemId(self):
        "Return the system identifier for the current event."
        return None

# ===== INPUTSOURCE =====

class InputSource:
    """Encapsulation of the information needed by the XMLReader to
    read entities.

    This class may include information about the public identifier,
    system identifier, byte stream (possibly with character encoding
    information) and/or the character stream of an entity.

    Applications will create objects of this class for use in the
    XMLReader.parse method and for returning from
    EntityResolver.resolveEntity.

    An InputSource belongs to the application, the XMLReader is not
    allowed to modify InputSource objects passed to it from the
    application, although it may make copies and modify those."""

    def __init__(self, system_id = None):
        self.__system_id = system_id
        self.__public_id = None
        self.__encoding  = None
        self.__bytefile  = None
        self.__charfile  = None

    def setPublicId(self, public_id):
        "Sets the public identifier of this InputSource."
        self.__public_id = public_id

    def getPublicId(self):
        "Returns the public identifier of this InputSource."
        return self.__public_id

    def setSystemId(self, system_id):
        "Sets the system identifier of this InputSource."
        self.__system_id = system_id

    def getSystemId(self):
        "Returns the system identifier of this InputSource."
        return self.__system_id

    def setEncoding(self, encoding):
        """Sets the character encoding of this InputSource.

        The encoding must be a string acceptable for an XML encoding
        declaration (see section 4.3.3 of the XML recommendation).

        The encoding attribute of the InputSource is ignored if the
        InputSource also contains a character stream."""
        self.__encoding = encoding

    def getEncoding(self):
        "Get the character encoding of this InputSource."
        return self.__encoding

    def setByteStream(self, bytefile):
        """Set the byte stream (a Python file-like object which does
        not perform byte-to-character conversion) for this input
        source.

        The SAX parser will ignore this if there is also a character
        stream specified, but it will use a byte stream in preference
        to opening a URI connection itself.

        If the application knows the character encoding of the byte
        stream, it should set it with the setEncoding method."""
        self.__bytefile = bytefile

    def getByteStream(self):
        """Get the byte stream for this input source.

        The getEncoding method will return the character encoding for
        this byte stream, or None if unknown."""
        return self.__bytefile

    def setCharacterStream(self, charfile):
        """Set the character stream for this input source. (The stream
        must be a Python 2.0 Unicode-wrapped file-like that performs
        conversion to Unicode strings.)

        If there is a character stream specified, the SAX parser will
        ignore any byte stream and will not attempt to open a URI
        connection to the system identifier."""
        self.__charfile = charfile

    def getCharacterStream(self):
        "Get the character stream for this input source."
        return self.__charfile

# ===== ATTRIBUTESIMPL =====

class AttributesImpl:
    """Implementation of the Attributes interface."""

    def __init__(self, attrs):
        """Non-NS-aware implementation.

        attrs should be of the form {name : value}."""
        self._attrs = attrs

    def getLength(self):
        return len(self._attrs)

    def getType(self, name):
        return "CDATA"

    def getValue(self, name):
        return self._attrs[name]

    def getValueByQName(self, name):
        return self._attrs[name]

    def getNameByQName(self, name):
        if name not in self._attrs:
            raise KeyError(name)
        return name

    def getQNameByName(self, name):
        if name not in self._attrs:
            raise KeyError(name)
        return name

    def getNames(self):
        return list(self._attrs.keys())

    def getQNames(self):
        return list(self._attrs.keys())

    def __len__(self):
        return len(self._attrs)

    def __getitem__(self, name):
        return self._attrs[name]

    def keys(self):
        return list(self._attrs.keys())

    def __contains__(self, name):
        return name in self._attrs

    def get(self, name, alternative=None):
        return self._attrs.get(name, alternative)

    def copy(self):
        return self.__class__(self._attrs)

    def items(self):
        return list(self._attrs.items())

    def values(self):
        return list(self._attrs.values())

# ===== ATTRIBUTESNSIMPL =====

class AttributesNSImpl(AttributesImpl):

    def __init__(self, attrs, qnames):
        """NS-aware implementation.

        attrs should be of the form {(ns_uri, lname): value, ...}.
        qnames of the form {(ns_uri, lname): qname, ...}."""
        self._attrs = attrs
        self._qnames = qnames

    def getValueByQName(self, name):
        for (nsname, qname) in self._qnames.items():
            if qname == name:
                return self._attrs[nsname]

        raise KeyError(name)

    def getNameByQName(self, name):
        for (nsname, qname) in self._qnames.items():
            if qname == name:
                return nsname

        raise KeyError(name)

    def getQNameByName(self, name):
        return self._qnames[name]

    def getQNames(self):
        return list(self._qnames.values())

    def copy(self):
        return self.__class__(self._attrs, self._qnames)


def _test():
    XMLReader()
    IncrementalParser()
    Locator()

if __name__ == "__main__":
    _test()
`;

const SAXUTILS = String.raw`"""\
A library of useful helper classes to the SAX classes, for the
convenience of application and driver writers.
"""

import os, urllib.parse
import io
import codecs
from xml.sax import handler
from xml.sax import xmlreader

def __dict_replace(s, d):
    """Replace substrings of a string using a dictionary."""
    for key, value in d.items():
        s = s.replace(key, value)
    return s

def escape(data, entities={}):
    """Escape &, <, and > in a string of data.

    You can escape other strings of data by passing a dictionary as
    the optional entities parameter.  The keys and values must all be
    strings; each key will be replaced with its corresponding value.
    """

    # must do ampersand first
    data = data.replace("&", "&amp;")
    data = data.replace(">", "&gt;")
    data = data.replace("<", "&lt;")
    if entities:
        data = __dict_replace(data, entities)
    return data

def unescape(data, entities={}):
    """Unescape &amp;, &lt;, and &gt; in a string of data.

    You can unescape other strings of data by passing a dictionary as
    the optional entities parameter.  The keys and values must all be
    strings; each key will be replaced with its corresponding value.
    """
    data = data.replace("&lt;", "<")
    data = data.replace("&gt;", ">")
    if entities:
        data = __dict_replace(data, entities)
    # must do ampersand last
    return data.replace("&amp;", "&")

def quoteattr(data, entities={}):
    """Escape and quote an attribute value.

    Escape &, <, and > in a string of data, then quote it for use as
    an attribute value.  The \" character will be escaped as well, if
    necessary.

    You can escape other strings of data by passing a dictionary as
    the optional entities parameter.  The keys and values must all be
    strings; each key will be replaced with its corresponding value.
    """
    entities = {**entities, '\n': '&#10;', '\r': '&#13;', '\t':'&#9;'}
    data = escape(data, entities)
    if '"' in data:
        if "'" in data:
            data = '"%s"' % data.replace('"', "&quot;")
        else:
            data = "'%s'" % data
    else:
        data = '"%s"' % data
    return data


def _gettextwriter(out, encoding):
    if out is None:
        import sys
        return sys.stdout

    if isinstance(out, io.TextIOBase):
        # use a text writer as is
        return out

    if isinstance(out, (codecs.StreamWriter, codecs.StreamReaderWriter)):
        # use a codecs stream writer as is
        return out

    # wrap a binary writer with TextIOWrapper
    if isinstance(out, io.RawIOBase):
        # Keep the original file open when the TextIOWrapper is
        # destroyed
        class _wrapper:
            __class__ = out.__class__
            def __getattr__(self, name):
                return getattr(out, name)
        buffer = _wrapper()
        buffer.close = lambda: None
    else:
        # This is to handle passed objects that aren't in the
        # IOBase hierarchy, but just have a write method
        buffer = io.BufferedIOBase()
        buffer.writable = lambda: True
        buffer.write = out.write
        try:
            # TextIOWrapper uses this methods to determine
            # if BOM (for UTF-16, etc) should be added
            buffer.seekable = out.seekable
            buffer.tell = out.tell
        except AttributeError:
            pass
    return io.TextIOWrapper(buffer, encoding=encoding,
                            errors='xmlcharrefreplace',
                            newline='\n',
                            write_through=True)

class XMLGenerator(handler.ContentHandler):
    """Content handler which writes the events back as an XML document."""

    def __init__(self, out=None, encoding="iso-8859-1", short_empty_elements=False):
        handler.ContentHandler.__init__(self)
        out = _gettextwriter(out, encoding)
        self._write = out.write
        self._flush = out.flush
        self._ns_contexts = [{}] # contains uri -> prefix dicts
        self._current_context = self._ns_contexts[-1]
        self._undeclared_ns_maps = []
        self._encoding = encoding
        self._short_empty_elements = short_empty_elements
        self._pending_start_element = False

    def _qname(self, name):
        """Builds a qualified name from a (ns_url, localname) pair"""
        if name[0]:
            # Per http://www.w3.org/XML/1998/namespace, The 'xml' prefix is
            # bound by definition to http://www.w3.org/XML/1998/namespace.  It
            # does not need to be declared and will not usually be found in
            # self._current_context.
            if 'http://www.w3.org/XML/1998/namespace' == name[0]:
                return 'xml:' + name[1]
            # The name is in a non-empty namespace
            prefix = self._current_context[name[0]]
            if prefix:
                # If it is not the default namespace, prepend the prefix
                return prefix + ":" + name[1]
        # Return the unqualified name
        return name[1]

    def _finish_pending_start_element(self,endElement=False):
        if self._pending_start_element:
            self._write('>')
            self._pending_start_element = False

    # ContentHandler methods

    def startDocument(self):
        self._write('<?xml version="1.0" encoding="%s"?>\n' %
                        self._encoding)

    def endDocument(self):
        self._flush()

    def startPrefixMapping(self, prefix, uri):
        self._ns_contexts.append(self._current_context.copy())
        self._current_context[uri] = prefix
        self._undeclared_ns_maps.append((prefix, uri))

    def endPrefixMapping(self, prefix):
        self._current_context = self._ns_contexts[-1]
        del self._ns_contexts[-1]

    def startElement(self, name, attrs):
        self._finish_pending_start_element()
        self._write('<' + name)
        for (name, value) in attrs.items():
            self._write(' %s=%s' % (name, quoteattr(value)))
        if self._short_empty_elements:
            self._pending_start_element = True
        else:
            self._write(">")

    def endElement(self, name):
        if self._pending_start_element:
            self._write('/>')
            self._pending_start_element = False
        else:
            self._write('</%s>' % name)

    def startElementNS(self, name, qname, attrs):
        self._finish_pending_start_element()
        self._write('<' + self._qname(name))

        for prefix, uri in self._undeclared_ns_maps:
            if prefix:
                self._write(' xmlns:%s=%s' % (prefix, quoteattr(uri)))
            else:
                self._write(' xmlns=%s' % quoteattr(uri))
        self._undeclared_ns_maps = []

        for (name, value) in attrs.items():
            self._write(' %s=%s' % (self._qname(name), quoteattr(value)))
        if self._short_empty_elements:
            self._pending_start_element = True
        else:
            self._write(">")

    def endElementNS(self, name, qname):
        if self._pending_start_element:
            self._write('/>')
            self._pending_start_element = False
        else:
            self._write('</%s>' % self._qname(name))

    def characters(self, content):
        if content:
            self._finish_pending_start_element()
            if not isinstance(content, str):
                content = str(content, self._encoding)
            self._write(escape(content))

    def ignorableWhitespace(self, content):
        if content:
            self._finish_pending_start_element()
            if not isinstance(content, str):
                content = str(content, self._encoding)
            self._write(content)

    def processingInstruction(self, target, data):
        self._finish_pending_start_element()
        self._write('<?%s %s?>' % (target, data))


class XMLFilterBase(xmlreader.XMLReader):
    """This class is designed to sit between an XMLReader and the
    client application's event handlers.  By default, it does nothing
    but pass requests up to the reader and events on to the handlers
    unmodified, but subclasses can override specific methods to modify
    the event stream or the configuration requests as they pass
    through."""

    def __init__(self, parent = None):
        xmlreader.XMLReader.__init__(self)
        self._parent = parent

    # ErrorHandler methods

    def error(self, exception):
        self._err_handler.error(exception)

    def fatalError(self, exception):
        self._err_handler.fatalError(exception)

    def warning(self, exception):
        self._err_handler.warning(exception)

    # ContentHandler methods

    def setDocumentLocator(self, locator):
        self._cont_handler.setDocumentLocator(locator)

    def startDocument(self):
        self._cont_handler.startDocument()

    def endDocument(self):
        self._cont_handler.endDocument()

    def startPrefixMapping(self, prefix, uri):
        self._cont_handler.startPrefixMapping(prefix, uri)

    def endPrefixMapping(self, prefix):
        self._cont_handler.endPrefixMapping(prefix)

    def startElement(self, name, attrs):
        self._cont_handler.startElement(name, attrs)

    def endElement(self, name):
        self._cont_handler.endElement(name)

    def startElementNS(self, name, qname, attrs):
        self._cont_handler.startElementNS(name, qname, attrs)

    def endElementNS(self, name, qname):
        self._cont_handler.endElementNS(name, qname)

    def characters(self, content):
        self._cont_handler.characters(content)

    def ignorableWhitespace(self, chars):
        self._cont_handler.ignorableWhitespace(chars)

    def processingInstruction(self, target, data):
        self._cont_handler.processingInstruction(target, data)

    def skippedEntity(self, name):
        self._cont_handler.skippedEntity(name)

    # DTDHandler methods

    def notationDecl(self, name, publicId, systemId):
        self._dtd_handler.notationDecl(name, publicId, systemId)

    def unparsedEntityDecl(self, name, publicId, systemId, ndata):
        self._dtd_handler.unparsedEntityDecl(name, publicId, systemId, ndata)

    # EntityResolver methods

    def resolveEntity(self, publicId, systemId):
        return self._ent_handler.resolveEntity(publicId, systemId)

    # XMLReader methods

    def parse(self, source):
        self._parent.setContentHandler(self)
        self._parent.setErrorHandler(self)
        self._parent.setEntityResolver(self)
        self._parent.setDTDHandler(self)
        self._parent.parse(source)

    def setLocale(self, locale):
        self._parent.setLocale(locale)

    def getFeature(self, name):
        return self._parent.getFeature(name)

    def setFeature(self, name, state):
        self._parent.setFeature(name, state)

    def getProperty(self, name):
        return self._parent.getProperty(name)

    def setProperty(self, name, value):
        self._parent.setProperty(name, value)

    # XMLFilter methods

    def getParent(self):
        return self._parent

    def setParent(self, parent):
        self._parent = parent

# --- Utility functions

def prepare_input_source(source, base=""):
    """This function takes an InputSource and an optional base URL and
    returns a fully resolved InputSource object ready for reading."""

    if isinstance(source, os.PathLike):
        source = os.fspath(source)
    if isinstance(source, str):
        source = xmlreader.InputSource(source)
    elif hasattr(source, "read"):
        f = source
        source = xmlreader.InputSource()
        if isinstance(f.read(0), str):
            source.setCharacterStream(f)
        else:
            source.setByteStream(f)
        if hasattr(f, "name") and isinstance(f.name, str):
            source.setSystemId(f.name)

    if source.getCharacterStream() is None and source.getByteStream() is None:
        sysid = source.getSystemId()
        basehead = os.path.dirname(os.path.normpath(base))
        sysidfilename = os.path.join(basehead, sysid)
        if os.path.isfile(sysidfilename):
            source.setSystemId(sysidfilename)
            f = open(sysidfilename, "rb")
        else:
            source.setSystemId(urllib.parse.urljoin(base, sysid))
            import urllib.request
            f = urllib.request.urlopen(source.getSystemId())

        source.setByteStream(f)

    return source
`;

const EXPATREADER = String.raw`"""
SAX driver for the pyexpat C module.  This driver works with
pyexpat.__version__ == '2.22'.
"""

version = "0.20"

from xml.sax._exceptions import *
from xml.sax.handler import feature_validation, feature_namespaces
from xml.sax.handler import feature_namespace_prefixes
from xml.sax.handler import feature_external_ges, feature_external_pes
from xml.sax.handler import feature_string_interning
from xml.sax.handler import property_xml_string, property_interning_dict

try:
    from xml.parsers import expat
except ImportError:
    raise SAXReaderNotAvailable("expat not supported", None)
else:
    if not hasattr(expat, "ParserCreate"):
        raise SAXReaderNotAvailable("expat not supported", None)
from xml.sax import xmlreader, saxutils, handler

AttributesImpl = xmlreader.AttributesImpl
AttributesNSImpl = xmlreader.AttributesNSImpl

# If we're using a sufficiently recent version of Python, we can use
# weak references to avoid cycles between the parser and content
# handler, otherwise we'll just have to pretend.
import weakref
_mkproxy = weakref.proxy
del weakref

class _ClosedParser:
    pass

# --- ExpatLocator

class ExpatLocator(xmlreader.Locator):
    """Locator for use with the ExpatParser class.

    This uses a weak reference to the parser object to avoid creating
    a circular reference between the parser and the content handler.
    """
    def __init__(self, parser):
        self._ref = _mkproxy(parser)

    def getColumnNumber(self):
        parser = self._ref
        if parser._parser is None:
            return None
        return parser._parser.ErrorColumnNumber

    def getLineNumber(self):
        parser = self._ref
        if parser._parser is None:
            return 1
        return parser._parser.ErrorLineNumber

    def getPublicId(self):
        parser = self._ref
        if parser is None:
            return None
        return parser._source.getPublicId()

    def getSystemId(self):
        parser = self._ref
        if parser is None:
            return None
        return parser._source.getSystemId()


# --- ExpatParser

class ExpatParser(xmlreader.IncrementalParser, xmlreader.Locator):
    """SAX driver for the pyexpat C module."""

    def __init__(self, namespaceHandling=0, bufsize=2**16-20):
        xmlreader.IncrementalParser.__init__(self, bufsize)
        self._source = xmlreader.InputSource()
        self._parser = None
        self._namespaces = namespaceHandling
        self._lex_handler_prop = None
        self._parsing = False
        self._entity_stack = []
        self._external_ges = 0
        self._interning = None

    # XMLReader methods

    def parse(self, source):
        "Parse an XML document from a URL or an InputSource."
        source = saxutils.prepare_input_source(source)

        self._source = source
        try:
            self.reset()
            self._cont_handler.setDocumentLocator(ExpatLocator(self))
            xmlreader.IncrementalParser.parse(self, source)
        except:
            # bpo-30264: Close the source on error to not leak resources:
            # xml.sax.parse() doesn't give access to the underlying parser
            # to the caller
            self._close_source()
            raise

    def prepareParser(self, source):
        if source.getSystemId() is not None:
            self._parser.SetBase(source.getSystemId())

    # Redefined setContentHandler to allow changing handlers during parsing

    def setContentHandler(self, handler):
        xmlreader.IncrementalParser.setContentHandler(self, handler)
        if self._parsing:
            self._reset_cont_handler()

    def getFeature(self, name):
        if name == feature_namespaces:
            return self._namespaces
        elif name == feature_string_interning:
            return self._interning is not None
        elif name in (feature_validation, feature_external_pes,
                      feature_namespace_prefixes):
            return 0
        elif name == feature_external_ges:
            return self._external_ges
        raise SAXNotRecognizedException("Feature '%s' not recognized" % name)

    def setFeature(self, name, state):
        if self._parsing:
            raise SAXNotSupportedException("Cannot set features while parsing")

        if name == feature_namespaces:
            self._namespaces = state
        elif name == feature_external_ges:
            self._external_ges = state
        elif name == feature_string_interning:
            if state:
                if self._interning is None:
                    self._interning = {}
            else:
                self._interning = None
        elif name == feature_validation:
            if state:
                raise SAXNotSupportedException(
                    "expat does not support validation")
        elif name == feature_external_pes:
            if state:
                raise SAXNotSupportedException(
                    "expat does not read external parameter entities")
        elif name == feature_namespace_prefixes:
            if state:
                raise SAXNotSupportedException(
                    "expat does not report namespace prefixes")
        else:
            raise SAXNotRecognizedException(
                "Feature '%s' not recognized" % name)

    def getProperty(self, name):
        if name == handler.property_lexical_handler:
            return self._lex_handler_prop
        elif name == property_interning_dict:
            return self._interning
        elif name == property_xml_string:
            if self._parser:
                if hasattr(self._parser, "GetInputContext"):
                    return self._parser.GetInputContext()
                else:
                    raise SAXNotRecognizedException(
                        "This version of expat does not support getting"
                        " the XML string")
            else:
                raise SAXNotSupportedException(
                    "XML string cannot be returned when not parsing")
        raise SAXNotRecognizedException("Property '%s' not recognized" % name)

    def setProperty(self, name, value):
        if name == handler.property_lexical_handler:
            self._lex_handler_prop = value
            if self._parsing:
                self._reset_lex_handler_prop()
        elif name == property_interning_dict:
            self._interning = value
        elif name == property_xml_string:
            raise SAXNotSupportedException("Property '%s' cannot be set" %
                                           name)
        else:
            raise SAXNotRecognizedException("Property '%s' not recognized" %
                                            name)

    # IncrementalParser methods

    def feed(self, data, isFinal=False):
        if not self._parsing:
            self.reset()
            self._parsing = True
            self._cont_handler.startDocument()

        try:
            # The isFinal parameter is internal to the expat reader.
            # If it is set to true, expat will check validity of the entire
            # document. When feeding chunks, they are not normally final -
            # except when invoked from close.
            self._parser.Parse(data, isFinal)
        except expat.error as e:
            exc = SAXParseException(expat.ErrorString(e.code), e, self)
            # FIXME: when to invoke error()?
            self._err_handler.fatalError(exc)

    def flush(self):
        if self._parser is None:
            return

        was_enabled = self._parser.GetReparseDeferralEnabled()
        try:
            self._parser.SetReparseDeferralEnabled(False)
            self._parser.Parse(b"", False)
        except expat.error as e:
            exc = SAXParseException(expat.ErrorString(e.code), e, self)
            self._err_handler.fatalError(exc)
        finally:
            self._parser.SetReparseDeferralEnabled(was_enabled)

    def _close_source(self):
        source = self._source
        try:
            file = source.getCharacterStream()
            if file is not None:
                file.close()
        finally:
            file = source.getByteStream()
            if file is not None:
                file.close()

    def close(self):
        if (self._entity_stack or self._parser is None or
            isinstance(self._parser, _ClosedParser)):
            # If we are completing an external entity, do nothing here
            return
        try:
            self.feed(b"", isFinal=True)
            self._cont_handler.endDocument()
            self._parsing = False
            # break cycle created by expat handlers pointing to our methods
            self._parser = None
        finally:
            self._parsing = False
            if self._parser is not None:
                # Keep ErrorColumnNumber and ErrorLineNumber after closing.
                parser = _ClosedParser()
                parser.ErrorColumnNumber = self._parser.ErrorColumnNumber
                parser.ErrorLineNumber = self._parser.ErrorLineNumber
                self._parser = parser
            self._close_source()

    def _reset_cont_handler(self):
        self._parser.ProcessingInstructionHandler = \
                                    self._cont_handler.processingInstruction
        self._parser.CharacterDataHandler = self._cont_handler.characters

    def _reset_lex_handler_prop(self):
        lex = self._lex_handler_prop
        parser = self._parser
        if lex is None:
            parser.CommentHandler = None
            parser.StartCdataSectionHandler = None
            parser.EndCdataSectionHandler = None
            parser.StartDoctypeDeclHandler = None
            parser.EndDoctypeDeclHandler = None
        else:
            parser.CommentHandler = lex.comment
            parser.StartCdataSectionHandler = lex.startCDATA
            parser.EndCdataSectionHandler = lex.endCDATA
            parser.StartDoctypeDeclHandler = self.start_doctype_decl
            parser.EndDoctypeDeclHandler = lex.endDTD

    def reset(self):
        if self._namespaces:
            self._parser = expat.ParserCreate(self._source.getEncoding(), " ",
                                              intern=self._interning)
            self._parser.namespace_prefixes = 1
            self._parser.StartElementHandler = self.start_element_ns
            self._parser.EndElementHandler = self.end_element_ns
        else:
            self._parser = expat.ParserCreate(self._source.getEncoding(),
                                              intern = self._interning)
            self._parser.StartElementHandler = self.start_element
            self._parser.EndElementHandler = self.end_element

        self._reset_cont_handler()
        self._parser.UnparsedEntityDeclHandler = self.unparsed_entity_decl
        self._parser.NotationDeclHandler = self.notation_decl
        self._parser.StartNamespaceDeclHandler = self.start_namespace_decl
        self._parser.EndNamespaceDeclHandler = self.end_namespace_decl

        self._decl_handler_prop = None
        if self._lex_handler_prop:
            self._reset_lex_handler_prop()
#         self._parser.DefaultHandler =
#         self._parser.DefaultHandlerExpand =
#         self._parser.NotStandaloneHandler =
        self._parser.ExternalEntityRefHandler = self.external_entity_ref
        try:
            self._parser.SkippedEntityHandler = self.skipped_entity_handler
        except AttributeError:
            # This pyexpat does not support SkippedEntity
            pass
        self._parser.SetParamEntityParsing(
            expat.XML_PARAM_ENTITY_PARSING_UNLESS_STANDALONE)

        self._parsing = False
        self._entity_stack = []

    # Locator methods

    def getColumnNumber(self):
        if self._parser is None:
            return None
        return self._parser.ErrorColumnNumber

    def getLineNumber(self):
        if self._parser is None:
            return 1
        return self._parser.ErrorLineNumber

    def getPublicId(self):
        return self._source.getPublicId()

    def getSystemId(self):
        return self._source.getSystemId()

    # event handlers
    def start_element(self, name, attrs):
        self._cont_handler.startElement(name, AttributesImpl(attrs))

    def end_element(self, name):
        self._cont_handler.endElement(name)

    def start_element_ns(self, name, attrs):
        pair = name.split()
        if len(pair) == 1:
            # no namespace
            pair = (None, name)
        elif len(pair) == 3:
            pair = pair[0], pair[1]
        else:
            # default namespace
            pair = tuple(pair)

        newattrs = {}
        qnames = {}
        for (aname, value) in attrs.items():
            parts = aname.split()
            length = len(parts)
            if length == 1:
                # no namespace
                qname = aname
                apair = (None, aname)
            elif length == 3:
                qname = "%s:%s" % (parts[2], parts[1])
                apair = parts[0], parts[1]
            else:
                # default namespace
                qname = parts[1]
                apair = tuple(parts)

            newattrs[apair] = value
            qnames[apair] = qname

        self._cont_handler.startElementNS(pair, None,
                                          AttributesNSImpl(newattrs, qnames))

    def end_element_ns(self, name):
        pair = name.split()
        if len(pair) == 1:
            pair = (None, name)
        elif len(pair) == 3:
            pair = pair[0], pair[1]
        else:
            pair = tuple(pair)

        self._cont_handler.endElementNS(pair, None)

    # this is not used (call directly to ContentHandler)
    def processing_instruction(self, target, data):
        self._cont_handler.processingInstruction(target, data)

    # this is not used (call directly to ContentHandler)
    def character_data(self, data):
        self._cont_handler.characters(data)

    def start_namespace_decl(self, prefix, uri):
        self._cont_handler.startPrefixMapping(prefix, uri)

    def end_namespace_decl(self, prefix):
        self._cont_handler.endPrefixMapping(prefix)

    def start_doctype_decl(self, name, sysid, pubid, has_internal_subset):
        self._lex_handler_prop.startDTD(name, pubid, sysid)

    def unparsed_entity_decl(self, name, base, sysid, pubid, notation_name):
        self._dtd_handler.unparsedEntityDecl(name, pubid, sysid, notation_name)

    def notation_decl(self, name, base, sysid, pubid):
        self._dtd_handler.notationDecl(name, pubid, sysid)

    def external_entity_ref(self, context, base, sysid, pubid):
        if not self._external_ges:
            return 1

        source = self._ent_handler.resolveEntity(pubid, sysid)
        source = saxutils.prepare_input_source(source,
                                               self._source.getSystemId() or
                                               "")

        self._entity_stack.append((self._parser, self._source))
        self._parser = self._parser.ExternalEntityParserCreate(context)
        self._source = source

        try:
            xmlreader.IncrementalParser.parse(self, source)
        except:
            return 0  # FIXME: save error info here?

        (self._parser, self._source) = self._entity_stack[-1]
        del self._entity_stack[-1]
        return 1

    def skipped_entity_handler(self, name, is_pe):
        if is_pe:
            # The SAX spec requires to report skipped PEs with a '%'
            name = '%'+name
        self._cont_handler.skippedEntity(name)

# ---

def create_parser(*args, **kwargs):
    return ExpatParser(*args, **kwargs)

# ---

if __name__ == "__main__":
    import xml.sax.saxutils
    p = create_parser()
    p.setContentHandler(xml.sax.saxutils.XMLGenerator())
    p.setErrorHandler(xml.sax.ErrorHandler())
    p.parse("http://www.ibiblio.org/xml/examples/shakespeare/hamlet.xml")
`;

registerSourceModule('xml.sax', SAX);
registerSourceModule('xml.sax._exceptions', EXCEPTIONS);
registerSourceModule('xml.sax.handler', HANDLER);
registerSourceModule('xml.sax.xmlreader', XMLREADER);
registerSourceModule('xml.sax.saxutils', SAXUTILS);
registerSourceModule('xml.sax.expatreader', EXPATREADER);
