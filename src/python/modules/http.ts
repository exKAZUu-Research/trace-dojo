import { registerSourceModule } from '../sourceModules';

// CPython's `http/__init__.py` and `http/cookies.py`; `http.client`, `http.server`, and `http.cookiejar` use the network
// and files.

const HTTP = String.raw`from enum import StrEnum, IntEnum, _simple_enum

__all__ = ['HTTPStatus', 'HTTPMethod']


@_simple_enum(IntEnum)
class HTTPStatus:
    """HTTP status codes and reason phrases

    Status codes from the following RFCs are all observed:

        * RFC 9110: HTTP Semantics, obsoletes 7231, which obsoleted 2616
        * RFC 6585: Additional HTTP Status Codes
        * RFC 3229: Delta encoding in HTTP
        * RFC 4918: HTTP Extensions for WebDAV, obsoletes 2518
        * RFC 5842: Binding Extensions to WebDAV
        * RFC 7238: Permanent Redirect
        * RFC 2295: Transparent Content Negotiation in HTTP
        * RFC 2774: An HTTP Extension Framework
        * RFC 7725: An HTTP Status Code to Report Legal Obstacles
        * RFC 7540: Hypertext Transfer Protocol Version 2 (HTTP/2)
        * RFC 2324: Hyper Text Coffee Pot Control Protocol (HTCPCP/1.0)
        * RFC 8297: An HTTP Status Code for Indicating Hints
        * RFC 8470: Using Early Data in HTTP
    """
    def __new__(cls, value, phrase, description=''):
        obj = int.__new__(cls, value)
        obj._value_ = value
        obj.phrase = phrase
        obj.description = description
        return obj

    @property
    def is_informational(self):
        return 100 <= self <= 199

    @property
    def is_success(self):
        return 200 <= self <= 299

    @property
    def is_redirection(self):
        return 300 <= self <= 399

    @property
    def is_client_error(self):
        return 400 <= self <= 499

    @property
    def is_server_error(self):
        return 500 <= self <= 599

    # informational
    CONTINUE = 100, 'Continue', 'Request received, please continue'
    SWITCHING_PROTOCOLS = (101, 'Switching Protocols',
            'Switching to new protocol; obey Upgrade header')
    PROCESSING = 102, 'Processing', 'Server is processing the request'
    EARLY_HINTS = (103, 'Early Hints',
            'Headers sent to prepare for the response')

    # success
    OK = 200, 'OK', 'Request fulfilled, document follows'
    CREATED = 201, 'Created', 'Document created, URL follows'
    ACCEPTED = (202, 'Accepted',
        'Request accepted, processing continues off-line')
    NON_AUTHORITATIVE_INFORMATION = (203,
        'Non-Authoritative Information', 'Request fulfilled from cache')
    NO_CONTENT = 204, 'No Content', 'Request fulfilled, nothing follows'
    RESET_CONTENT = 205, 'Reset Content', 'Clear input form for further input'
    PARTIAL_CONTENT = 206, 'Partial Content', 'Partial content follows'
    MULTI_STATUS = (207, 'Multi-Status',
        'Response contains multiple statuses in the body')
    ALREADY_REPORTED = (208, 'Already Reported',
        'Operation has already been reported')
    IM_USED = 226, 'IM Used', 'Request completed using instance manipulations'

    # redirection
    MULTIPLE_CHOICES = (300, 'Multiple Choices',
        'Object has several resources -- see URI list')
    MOVED_PERMANENTLY = (301, 'Moved Permanently',
        'Object moved permanently -- see URI list')
    FOUND = 302, 'Found', 'Object moved temporarily -- see URI list'
    SEE_OTHER = 303, 'See Other', 'Object moved -- see Method and URL list'
    NOT_MODIFIED = (304, 'Not Modified',
        'Document has not changed since given time')
    USE_PROXY = (305, 'Use Proxy',
        'You must use proxy specified in Location to access this resource')
    TEMPORARY_REDIRECT = (307, 'Temporary Redirect',
        'Object moved temporarily -- see URI list')
    PERMANENT_REDIRECT = (308, 'Permanent Redirect',
        'Object moved permanently -- see URI list')

    # client error
    BAD_REQUEST = (400, 'Bad Request',
        'Bad request syntax or unsupported method')
    UNAUTHORIZED = (401, 'Unauthorized',
        'No permission -- see authorization schemes')
    PAYMENT_REQUIRED = (402, 'Payment Required',
        'No payment -- see charging schemes')
    FORBIDDEN = (403, 'Forbidden',
        'Request forbidden -- authorization will not help')
    NOT_FOUND = (404, 'Not Found',
        'Nothing matches the given URI')
    METHOD_NOT_ALLOWED = (405, 'Method Not Allowed',
        'Specified method is invalid for this resource')
    NOT_ACCEPTABLE = (406, 'Not Acceptable',
        'URI not available in preferred format')
    PROXY_AUTHENTICATION_REQUIRED = (407,
        'Proxy Authentication Required',
        'You must authenticate with this proxy before proceeding')
    REQUEST_TIMEOUT = (408, 'Request Timeout',
        'Request timed out; try again later')
    CONFLICT = 409, 'Conflict', 'Request conflict'
    GONE = (410, 'Gone',
        'URI no longer exists and has been permanently removed')
    LENGTH_REQUIRED = (411, 'Length Required',
        'Client must specify Content-Length')
    PRECONDITION_FAILED = (412, 'Precondition Failed',
        'Precondition in headers is false')
    CONTENT_TOO_LARGE = (413, 'Content Too Large',
        'Content is too large')
    REQUEST_ENTITY_TOO_LARGE = CONTENT_TOO_LARGE
    URI_TOO_LONG = (414, 'URI Too Long',
        'URI is too long')
    REQUEST_URI_TOO_LONG = URI_TOO_LONG
    UNSUPPORTED_MEDIA_TYPE = (415, 'Unsupported Media Type',
        'Entity body in unsupported format')
    RANGE_NOT_SATISFIABLE = (416, 'Range Not Satisfiable',
        'Cannot satisfy request range')
    REQUESTED_RANGE_NOT_SATISFIABLE = RANGE_NOT_SATISFIABLE
    EXPECTATION_FAILED = (417, 'Expectation Failed',
        'Expect condition could not be satisfied')
    IM_A_TEAPOT = (418, 'I\'m a Teapot',
        'Server refuses to brew coffee because it is a teapot')
    MISDIRECTED_REQUEST = (421, 'Misdirected Request',
        'Server is not able to produce a response')
    UNPROCESSABLE_CONTENT = (422, 'Unprocessable Content',
        'Server is not able to process the contained instructions')
    UNPROCESSABLE_ENTITY = UNPROCESSABLE_CONTENT
    LOCKED = 423, 'Locked', 'Resource of a method is locked'
    FAILED_DEPENDENCY = (424, 'Failed Dependency',
        'Dependent action of the request failed')
    TOO_EARLY = (425, 'Too Early',
        'Server refuses to process a request that might be replayed')
    UPGRADE_REQUIRED = (426, 'Upgrade Required',
        'Server refuses to perform the request using the current protocol')
    PRECONDITION_REQUIRED = (428, 'Precondition Required',
        'The origin server requires the request to be conditional')
    TOO_MANY_REQUESTS = (429, 'Too Many Requests',
        'The user has sent too many requests in '
        'a given amount of time ("rate limiting")')
    REQUEST_HEADER_FIELDS_TOO_LARGE = (431,
        'Request Header Fields Too Large',
        'The server is unwilling to process the request because its header '
        'fields are too large')
    UNAVAILABLE_FOR_LEGAL_REASONS = (451,
        'Unavailable For Legal Reasons',
        'The server is denying access to the '
        'resource as a consequence of a legal demand')

    # server errors
    INTERNAL_SERVER_ERROR = (500, 'Internal Server Error',
        'Server got itself in trouble')
    NOT_IMPLEMENTED = (501, 'Not Implemented',
        'Server does not support this operation')
    BAD_GATEWAY = (502, 'Bad Gateway',
        'Invalid responses from another server/proxy')
    SERVICE_UNAVAILABLE = (503, 'Service Unavailable',
        'The server cannot process the request due to a high load')
    GATEWAY_TIMEOUT = (504, 'Gateway Timeout',
        'The gateway server did not receive a timely response')
    HTTP_VERSION_NOT_SUPPORTED = (505, 'HTTP Version Not Supported',
        'Cannot fulfill request')
    VARIANT_ALSO_NEGOTIATES = (506, 'Variant Also Negotiates',
        'Server has an internal configuration error')
    INSUFFICIENT_STORAGE = (507, 'Insufficient Storage',
        'Server is not able to store the representation')
    LOOP_DETECTED = (508, 'Loop Detected',
        'Server encountered an infinite loop while processing a request')
    NOT_EXTENDED = (510, 'Not Extended',
        'Request does not meet the resource access policy')
    NETWORK_AUTHENTICATION_REQUIRED = (511,
        'Network Authentication Required',
        'The client needs to authenticate to gain network access')


@_simple_enum(StrEnum)
class HTTPMethod:
    """HTTP methods and descriptions

    Methods from the following RFCs are all observed:

        * RFC 9110: HTTP Semantics, obsoletes 7231, which obsoleted 2616
        * RFC 5789: PATCH Method for HTTP
    """
    def __new__(cls, value, description):
        obj = str.__new__(cls, value)
        obj._value_ = value
        obj.description = description
        return obj

    def __repr__(self):
        return "<%s.%s>" % (self.__class__.__name__, self._name_)

    CONNECT = 'CONNECT', 'Establish a connection to the server.'
    DELETE = 'DELETE', 'Remove the target.'
    GET = 'GET', 'Retrieve the target.'
    HEAD = 'HEAD', 'Same as GET, but only retrieve the status line and header section.'
    OPTIONS = 'OPTIONS', 'Describe the communication options for the target.'
    PATCH = 'PATCH', 'Apply partial modifications to a target.'
    POST = 'POST', 'Perform target-specific processing with the request payload.'
    PUT = 'PUT', 'Replace the target with the request payload.'
    TRACE = 'TRACE', 'Perform a message loop-back test along the path to the target.'
`;

const COOKIES =
  String.raw`####
# Copyright 2000 by Timothy O'Malley <timo@alum.mit.edu>
#
#                All Rights Reserved
#
# Permission to use, copy, modify, and distribute this software
# and its documentation for any purpose and without fee is hereby
# granted, provided that the above copyright notice appear in all
# copies and that both that copyright notice and this permission
# notice appear in supporting documentation, and that the name of
# Timothy O'Malley  not be used in advertising or publicity
# pertaining to distribution of the software without specific, written
# prior permission.
#
# Timothy O'Malley DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
# SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
# AND FITNESS, IN NO EVENT SHALL Timothy O'Malley BE LIABLE FOR
# ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
# WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
# WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
# ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
# PERFORMANCE OF THIS SOFTWARE.
#
####
#
# Id: Cookie.py,v 2.29 2000/08/23 05:28:49 timo Exp
#   by Timothy O'Malley <timo@alum.mit.edu>
#
#  Cookie.py is a Python module for the handling of HTTP
#  cookies as a Python dictionary.  See RFC 2109 for more
#  information on cookies.
#
#  The original idea to treat Cookies as a dictionary came from
#  Dave Mitchell (davem@magnet.com) in 1995, when he released the
#  first version of nscookie.py.
#
####

r"""
Here's a sample session to show how to use this module.
At the moment, this is the only documentation.

The Basics
----------

Importing is easy...

   >>> from http import cookies

Most of the time you start by creating a cookie.

   >>> C = cookies.SimpleCookie()

Once you've created your Cookie, you can add values just as if it were
a dictionary.

   >>> C = cookies.SimpleCookie()
   >>> C["fig"] = "newton"
   >>> C["sugar"] = "wafer"
   >>> C.output()
   'Set-Cookie: fig=newton\r\nSet-Cookie: sugar=wafer'

Notice that the printable representation of a Cookie is the
appropriate format for a Set-Cookie: header.  This is the
default behavior.  You can change the header and printed
attributes by using the .output() function

   >>> C = cookies.SimpleCookie()
   >>> C["rocky"] = "road"
   >>> C["rocky"]["path"] = "/cookie"
   >>> print(C.output(header="Cookie:"))
   Cookie: rocky=road; Path=/cookie
   >>> print(C.output(attrs=[], header="Cookie:"))
   Cookie: rocky=road

The load() method of a Cookie extracts cookies from a string.  In a
CGI script, you would use this method to extract the cookies from the
HTTP_COOKIE environment variable.

   >>> C = cookies.SimpleCookie()
   >>> C.load("chips=ahoy; vienna=finger")
   >>> C.output()
   'Set-Cookie: chips=ahoy\r\nSet-Cookie: vienna=finger'

The load() method is darn-tootin smart about identifying cookies
within a string.  Escaped quotation marks, nested semicolons, and other
such trickeries do not confuse it.

   >>> C = cookies.SimpleCookie()
   >>> C.load('keebler="E=everybody; L=\\"Loves\\"; fudge=;";')
   >>> print(C)
   Set-Cookie: keebler="E=everybody; L=\"Loves\"; fudge=;"

Each element of the Cookie also supports all of the RFC 2109
Cookie attributes.  Here's an example which sets the Path
attribute.

   >>> C = cookies.SimpleCookie()
   >>> C["oreo"] = "doublestuff"
   >>> C["oreo"]["path"] = "/"
   >>> print(C)
   Set-Cookie: oreo=doublestuff; Path=/

Each dictionary element has a 'value' attribute, which gives you
back the value associated with the key.

   >>> C = cookies.SimpleCookie()
   >>> C["twix"] = "none for you"
   >>> C["twix"].value
   'none for you'

The SimpleCookie expects that all values should be standard strings.
Just to be sure, SimpleCookie invokes the str() builtin to convert
the value to a string, when the values are set dictionary-style.

   >>> C = cookies.SimpleCookie()
   >>> C["number"] = 7
   >>> C["string"] = "seven"
   >>> C["number"].value
   '7'
   >>> C["string"].value
   'seven'
   >>> C.output()
   'Set-Cookie: number=7\r\nSet-Cookie: string=seven'

Finis.
"""

#
# Import our required modules
#
import re
import string
import types

__all__ = ["CookieError", "BaseCookie", "SimpleCookie"]

_nulljoin = ''.join
_semispacejoin = '; '.join
_spacejoin = ' '.join

#
# Define an exception visible to External modules
#
class CookieError(Exception):
    pass


# These quoting routines conform to the RFC2109 specification, which in
# turn references the character definitions from RFC2068.  They provide
# a two-way quoting algorithm.  Any non-text character is translated
# into a 4 character sequence: a forward-slash followed by the
# three-digit octal equivalent of the character.  Any '\' or '"' is
# quoted with a preceding '\' slash.
# Because of the way browsers really handle cookies (as opposed to what
# the RFC says) we also encode "," and ";".
#
# These are taken from RFC2068 and RFC2109.
#       _LegalChars       is the list of chars which don't require "'s
#       _Translator       hash-table for fast quoting
#
_LegalChars = string.ascii_letters + string.digits + "!#$%&'*+-.^_` +
  '`' +
  String.raw`|~:"
_UnescapedChars = _LegalChars + ' ()/<=>?@[]{}'

_Translator = {n: '\\%03o' % n
               for n in set(range(256)) - set(map(ord, _UnescapedChars))}
_Translator.update({
    ord('"'): '\\"',
    ord('\\'): '\\\\',
})

_is_legal_key = re.compile('[%s]+' % re.escape(_LegalChars)).fullmatch
_control_character_re = re.compile(r'[\x00-\x1F\x7F]')


def _has_control_character(*val):
    """Detects control characters within a value.
    Supports any type, as header values can be any type.
    """
    return any(_control_character_re.search(str(v)) for v in val)


def _quote(str):
    r"""Quote a string for use in a cookie header.

    If the string does not need to be double-quoted, then just return the
    string.  Otherwise, surround the string in doublequotes and quote
    (with a \) special characters.
    """
    if str is None or _is_legal_key(str):
        return str
    else:
        return '"' + str.translate(_Translator) + '"'


_unquote_sub = re.compile(r'\\(?:([0-3][0-7][0-7])|(.))').sub

def _unquote_replace(m):
    if m[1]:
        return chr(int(m[1], 8))
    else:
        return m[2]

def _unquote(str):
    # If there aren't any doublequotes,
    # then there can't be any special characters.  See RFC 2109.
    if str is None or len(str) < 2:
        return str
    if str[0] != '"' or str[-1] != '"':
        return str

    # We have to assume that we must decode this string.
    # Down to work.

    # Remove the "s
    str = str[1:-1]

    # Check for special sequences.  Examples:
    #    \012 --> \n
    #    \"   --> "
    #
    return _unquote_sub(_unquote_replace, str)

# The _getdate() routine is used to set the expiration time in the cookie's HTTP
# header.  By default, _getdate() returns the current time in the appropriate
# "expires" format for a Set-Cookie header.  The one optional argument is an
# offset from now, in seconds.  For example, an offset of -3600 means "one hour
# ago".  The offset may be a floating-point number.
#

_weekdayname = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

_monthname = [None,
              'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

def _getdate(future=0, weekdayname=_weekdayname, monthname=_monthname):
    from time import gmtime, time
    now = time()
    year, month, day, hh, mm, ss, wd, y, z = gmtime(now + future)
    return "%s, %02d %3s %4d %02d:%02d:%02d GMT" % \
           (weekdayname[wd], day, monthname[month], year, hh, mm, ss)


class Morsel(dict):
    """A class to hold ONE (key, value) pair.

    In a cookie, each such pair may have several attributes, so this class is
    used to keep the attributes associated with the appropriate key,value pair.
    This class also includes a coded_value attribute, which is used to hold
    the network representation of the value.
    """
    # RFC 2109 lists these attributes as reserved:
    #   path       comment         domain
    #   max-age    secure      version
    #
    # For historical reasons, these attributes are also reserved:
    #   expires
    #
    # This is an extension from Microsoft:
    #   httponly
    #
    # This dictionary provides a mapping from the lowercase
    # variant on the left to the appropriate traditional
    # formatting on the right.
    _reserved = {
        "expires"  : "expires",
        "path"     : "Path",
        "comment"  : "Comment",
        "domain"   : "Domain",
        "max-age"  : "Max-Age",
        "secure"   : "Secure",
        "httponly" : "HttpOnly",
        "version"  : "Version",
        "samesite" : "SameSite",
        "partitioned": "Partitioned",
    }

    _reserved_defaults = dict.fromkeys(_reserved, "")

    _flags = {'secure', 'httponly', 'partitioned'}

    def __init__(self):
        # Set defaults
        self._key = self._value = self._coded_value = None

        # Set default attributes
        dict.update(self, self._reserved_defaults)

    @property
    def key(self):
        return self._key

    @property
    def value(self):
        return self._value

    @property
    def coded_value(self):
        return self._coded_value

    def __setitem__(self, K, V):
        K = K.lower()
        if not K in self._reserved:
            raise CookieError("Invalid attribute %r" % (K,))
        if _has_control_character(K, V):
            raise CookieError(f"Control characters are not allowed in cookies {K!r} {V!r}")
        dict.__setitem__(self, K, V)

    def setdefault(self, key, val=None):
        key = key.lower()
        if key not in self._reserved:
            raise CookieError("Invalid attribute %r" % (key,))
        if _has_control_character(key, val):
            raise CookieError("Control characters are not allowed in cookies %r %r" % (key, val,))
        return dict.setdefault(self, key, val)

    def __eq__(self, morsel):
        if not isinstance(morsel, Morsel):
            return NotImplemented
        return (dict.__eq__(self, morsel) and
                self._value == morsel._value and
                self._key == morsel._key and
                self._coded_value == morsel._coded_value)

    __ne__ = object.__ne__

    def copy(self):
        morsel = Morsel()
        dict.update(morsel, self)
        morsel.__dict__.update(self.__dict__)
        return morsel

    def update(self, values):
        data = {}
        for key, val in dict(values).items():
            key = key.lower()
            if key not in self._reserved:
                raise CookieError("Invalid attribute %r" % (key,))
            if _has_control_character(key, val):
                raise CookieError("Control characters are not allowed in "
                                  f"cookies {key!r} {val!r}")
            data[key] = val
        dict.update(self, data)

    def __ior__(self, values):
        self.update(values)
        return self

    def isReservedKey(self, K):
        return K.lower() in self._reserved

    def set(self, key, val, coded_val):
        if key.lower() in self._reserved:
            raise CookieError('Attempt to set a reserved key %r' % (key,))
        if not _is_legal_key(key):
            raise CookieError('Illegal key %r' % (key,))
        if _has_control_character(key, val, coded_val):
            raise CookieError(
                "Control characters are not allowed in cookies %r %r %r" % (key, val, coded_val,))

        # It's a good key, so save it.
        self._key = key
        self._value = val
        self._coded_value = coded_val

    def __getstate__(self):
        return {
            'key': self._key,
            'value': self._value,
            'coded_value': self._coded_value,
        }

    def __setstate__(self, state):
        key = state['key']
        value = state['value']
        coded_value = state['coded_value']
        if _has_control_character(key, value, coded_value):
            raise CookieError("Control characters are not allowed in cookies "
                              f"{key!r} {value!r} {coded_value!r}")
        self._key = key
        self._value = value
        self._coded_value = coded_value

    def output(self, attrs=None, header="Set-Cookie:"):
        return "%s %s" % (header, self.OutputString(attrs))

    __str__ = output

    def __repr__(self):
        return '<%s: %s>' % (self.__class__.__name__, self.OutputString())

    def js_output(self, attrs=None):
        import urllib.parse
        # Print javascript
        output_string = self.OutputString(attrs)
        if _has_control_character(output_string):
            raise CookieError("Control characters are not allowed in cookies")
        # Base64-encode value to avoid template
        # injection in cookie values.
        output_encoded = urllib.parse.quote(output_string, safe='', encoding='utf-8')
        return """
        <script type="text/javascript">
        <!-- begin hiding
        document.cookie = decodeURIComponent(\"%s\");
        // end hiding -->
        </script>
        """ % (output_encoded,)

    def OutputString(self, attrs=None):
        # Build up our result
        #
        result = []
        append = result.append

        # First, the key=value pair
        append("%s=%s" % (self.key, self.coded_value))

        # Now add any defined attributes
        if attrs is None:
            attrs = self._reserved
        items = sorted(self.items())
        for key, value in items:
            if value == "":
                continue
            if key not in attrs:
                continue
            if key == "expires" and isinstance(value, int):
                append("%s=%s" % (self._reserved[key], _getdate(value)))
            elif key == "max-age" and isinstance(value, int):
                append("%s=%d" % (self._reserved[key], value))
            elif key == "comment" and isinstance(value, str):
                append("%s=%s" % (self._reserved[key], _quote(value)))
            elif key in self._flags:
                if value:
                    append(str(self._reserved[key]))
            else:
                append("%s=%s" % (self._reserved[key], value))

        # Return the result
        return _semispacejoin(result)

    __class_getitem__ = classmethod(types.GenericAlias)


#
# Pattern for finding cookie
#
# This used to be strict parsing based on the RFC2109 and RFC2068
# specifications.  I have since discovered that MSIE 3.0x doesn't
# follow the character rules outlined in those specs.  As a
# result, the parsing rules here are less strict.
#

_LegalKeyChars  = r"\w\d!#%&'~_` +
  '`' +
  String.raw`><@,:/\$\*\+\-\.\^\|\)\(\?\}\{\="
_LegalValueChars = _LegalKeyChars + r'\[\]'
_CookiePattern = re.compile(r"""
    \s*                            # Optional whitespace at start of cookie
    (?P<key>                       # Start of group 'key'
    [""" + _LegalKeyChars + r"""]+?   # Any word of at least one letter
    )                              # End of group 'key'
    (                              # Optional group: there may not be a value.
    \s*=\s*                          # Equal Sign
    (?P<val>                         # Start of group 'val'
    "(?:[^\\"]|\\.)*"                  # Any double-quoted string
    |                                  # or
    # Special case for "expires" attr
    (\w{3,6}day|\w{3}),\s              # Day of the week or abbreviated day
    [\w\d\s-]{9,11}\s[\d:]{8}\sGMT     # Date and time in specific format
    |                                  # or
    [""" + _LegalValueChars + r"""]*      # Any word or empty string
    )                                # End of group 'val'
    )?                             # End of optional value group
    \s*                            # Any number of spaces.
    (\s+|;|$)                      # Ending either at space, semicolon, or EOS.
    """, re.ASCII | re.VERBOSE)    # re.ASCII may be removed if safe.


# At long last, here is the cookie class.  Using this class is almost just like
# using a dictionary.  See this module's docstring for example usage.
#
class BaseCookie(dict):
    """A container class for a set of Morsels."""

    def value_decode(self, val):
        """real_value, coded_value = value_decode(STRING)
        Called prior to setting a cookie's value from the network
        representation.  The VALUE is the value read from HTTP
        header.
        Override this function to modify the behavior of cookies.
        """
        return val, val

    def value_encode(self, val):
        """real_value, coded_value = value_encode(VALUE)
        Called prior to setting a cookie's value from the dictionary
        representation.  The VALUE is the value being assigned.
        Override this function to modify the behavior of cookies.
        """
        strval = str(val)
        return strval, strval

    def __init__(self, input=None):
        if input:
            self.load(input)

    def __set(self, key, real_value, coded_value):
        """Private method for setting a cookie's value"""
        M = self.get(key, Morsel())
        M.set(key, real_value, coded_value)
        dict.__setitem__(self, key, M)

    def __setitem__(self, key, value):
        """Dictionary style assignment."""
        if isinstance(value, Morsel):
            # allow assignment of constructed Morsels (e.g. for pickling)
            dict.__setitem__(self, key, value)
        else:
            rval, cval = self.value_encode(value)
            self.__set(key, rval, cval)

    def output(self, attrs=None, header="Set-Cookie:", sep="\015\012"):
        """Return a string suitable for HTTP."""
        result = []
        items = sorted(self.items())
        for key, value in items:
            value_output = value.output(attrs, header)
            if _has_control_character(value_output):
                raise CookieError("Control characters are not allowed in cookies")
            result.append(value_output)
        return sep.join(result)

    __str__ = output

    def __repr__(self):
        l = []
        items = sorted(self.items())
        for key, value in items:
            l.append('%s=%s' % (key, repr(value.value)))
        return '<%s: %s>' % (self.__class__.__name__, _spacejoin(l))

    def js_output(self, attrs=None):
        """Return a string suitable for JavaScript."""
        result = []
        items = sorted(self.items())
        for key, value in items:
            result.append(value.js_output(attrs))
        return _nulljoin(result)

    def load(self, rawdata):
        """Load cookies from a string (presumably HTTP_COOKIE) or
        from a dictionary.  Loading cookies from a dictionary 'd'
        is equivalent to calling:
            map(Cookie.__setitem__, d.keys(), d.values())
        """
        if isinstance(rawdata, str):
            self.__parse_string(rawdata)
        else:
            # self.update() wouldn't call our custom __setitem__
            for key, value in rawdata.items():
                self[key] = value
        return

    def __parse_string(self, str, patt=_CookiePattern):
        i = 0                 # Our starting point
        n = len(str)          # Length of string
        parsed_items = []     # Parsed (type, key, value) triples
        morsel_seen = False   # A key=value pair was previously encountered

        TYPE_ATTRIBUTE = 1
        TYPE_KEYVALUE = 2

        # We first parse the whole cookie string and reject it if it's
        # syntactically invalid (this helps avoid some classes of injection
        # attacks).
        while 0 <= i < n:
            # Start looking for a cookie
            match = patt.match(str, i)
            if not match:
                # No more cookies
                break

            key, value = match.group("key"), match.group("val")
            i = match.end(0)

            if key[0] == "$":
                if not morsel_seen:
                    # We ignore attributes which pertain to the cookie
                    # mechanism as a whole, such as "$Version".
                    # See RFC 2965. (Does anyone care?)
                    continue
                parsed_items.append((TYPE_ATTRIBUTE, key[1:], value))
            elif key.lower() in Morsel._reserved:
                if not morsel_seen:
                    # Invalid cookie string
                    return
                if value is None:
                    if key.lower() in Morsel._flags:
                        parsed_items.append((TYPE_ATTRIBUTE, key, True))
                    else:
                        # Invalid cookie string
                        return
                else:
                    parsed_items.append((TYPE_ATTRIBUTE, key, _unquote(value)))
            elif value is not None:
                parsed_items.append((TYPE_KEYVALUE, key, self.value_decode(value)))
                morsel_seen = True
            else:
                # Invalid cookie string
                return

        # The cookie string is valid, apply it.
        M = None         # current morsel
        for tp, key, value in parsed_items:
            if tp == TYPE_ATTRIBUTE:
                assert M is not None
                M[key] = value
            else:
                assert tp == TYPE_KEYVALUE
                rval, cval = value
                self.__set(key, rval, cval)
                M = self[key]


class SimpleCookie(BaseCookie):
    """
    SimpleCookie supports strings as cookie values.  When setting
    the value using the dictionary assignment notation, SimpleCookie
    calls the builtin str() to convert the value to a string.  Values
    received from HTTP are kept as strings.
    """
    def value_decode(self, val):
        return _unquote(val), val

    def value_encode(self, val):
        strval = str(val)
        return strval, _quote(strval)
`;

registerSourceModule('http', HTTP);
registerSourceModule('http.cookies', COOKIES);
