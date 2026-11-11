// The text renderer of CPython 3.14's `Lib/pydoc.py`, which `help()` of a class runs, with the helpers it uses.
export const PYDOC_SOURCE = String.raw`import __future__
import builtins
import inspect
import re
import sys
import textwrap
from annotationlib import Format
from collections import deque
from reprlib import Repr

def _findclass(func):
    cls = sys.modules.get(func.__module__)
    if cls is None:
        return None
    for name in func.__qualname__.split('.')[:-1]:
        cls = getattr(cls, name)
    if not inspect.isclass(cls):
        return None
    return cls

def _finddoc(obj):
    if inspect.ismethod(obj):
        name = obj.__func__.__name__
        self = obj.__self__
        if (inspect.isclass(self) and
            getattr(getattr(self, name, None), '__func__') is obj.__func__):
            # classmethod
            cls = self
        else:
            cls = self.__class__
    elif inspect.isfunction(obj):
        name = obj.__name__
        cls = _findclass(obj)
        if cls is None or getattr(cls, name) is not obj:
            return None
    elif inspect.isbuiltin(obj):
        name = obj.__name__
        self = obj.__self__
        if (inspect.isclass(self) and
            self.__qualname__ + '.' + name == obj.__qualname__):
            # classmethod
            cls = self
        else:
            cls = self.__class__
    # Should be tested before isdatadescriptor().
    elif isinstance(obj, property):
        name = obj.__name__
        cls = _findclass(obj.fget)
        if cls is None or getattr(cls, name) is not obj:
            return None
    elif inspect.ismethoddescriptor(obj) or inspect.isdatadescriptor(obj):
        name = obj.__name__
        cls = obj.__objclass__
        if getattr(cls, name) is not obj:
            return None
        if inspect.ismemberdescriptor(obj):
            slots = getattr(cls, '__slots__', None)
            if isinstance(slots, dict) and name in slots:
                return slots[name]
    else:
        return None
    for base in cls.__mro__:
        try:
            doc = _getowndoc(getattr(base, name))
        except AttributeError:
            continue
        if doc is not None:
            return doc
    return None

def _getowndoc(obj):
    """Get the documentation string for an object if it is not
    inherited from its class."""
    try:
        doc = object.__getattribute__(obj, '__doc__')
        if doc is None:
            return None
        if obj is not type:
            typedoc = type(obj).__doc__
            if isinstance(typedoc, str) and typedoc == doc:
                return None
        return doc
    except AttributeError:
        return None

def _getdoc(object):
    """Get the documentation string for an object.

    All tabs are expanded to spaces.  To clean up docstrings that are
    indented to line up with blocks of code, any whitespace than can be
    uniformly removed from the second line onwards is removed."""
    doc = _getowndoc(object)
    if doc is None:
        try:
            doc = _finddoc(object)
        except (AttributeError, TypeError):
            return None
    if not isinstance(doc, str):
        return None
    return inspect.cleandoc(doc)

def getdoc(object):
    """Get the doc string or comments for an object."""
    result = _getdoc(object) or inspect.getcomments(object)
    return result and re.sub('^ *\n', '', result.rstrip()) or ''

def splitdoc(doc):
    """Split a doc string into a synopsis line (if any) and the rest."""
    lines = doc.strip().split('\n')
    if len(lines) == 1:
        return lines[0], ''
    elif len(lines) >= 2 and not lines[1].rstrip():
        return lines[0], '\n'.join(lines[2:])
    return '', '\n'.join(lines)

def _getargspec(object):
    try:
        signature = inspect.signature(object, annotation_format=Format.STRING)
        if signature:
            name = getattr(object, '__name__', '')
            # <lambda> function are always single-line and should not be formatted
            max_width = (80 - len(name)) if name != '<lambda>' else None
            return signature.format(max_width=max_width, quote_annotation_strings=False)
    except (ValueError, TypeError):
        argspec = getattr(object, '__text_signature__', None)
        if argspec:
            if argspec[:2] == '($':
                argspec = '(' + argspec[2:]
            if getattr(object, '__self__', None) is not None:
                # Strip the bound argument.
                m = re.match(r'\(\w+(?:(?=\))|,\s*(?:/(?:(?=\))|,\s*))?)', argspec)
                if m:
                    argspec = '(' + argspec[m.end():]
        return argspec
    return None

def classname(object, modname):
    """Get a class name and qualify it with a module name if necessary."""
    name = object.__name__
    if object.__module__ != modname:
        name = object.__module__ + '.' + name
    return name

def parentname(object, modname):
    """Get a name of the enclosing class (qualified it with a module name
    if necessary) or module."""
    if '.' in object.__qualname__:
        name = object.__qualname__.rpartition('.')[0]
        if object.__module__ != modname and object.__module__ is not None:
            return object.__module__ + '.' + name
        else:
            return name
    else:
        if object.__module__ != modname:
            return object.__module__

def isdata(object):
    """Check if an object is of a type that probably means it's data."""
    return not (inspect.ismodule(object) or inspect.isclass(object) or
                inspect.isroutine(object) or inspect.isframe(object) or
                inspect.istraceback(object) or inspect.iscode(object))

def replace(text, *pairs):
    """Do a series of global replacements on a string."""
    while pairs:
        text = pairs[1].join(text.split(pairs[0]))
        pairs = pairs[2:]
    return text

def cram(text, maxlen):
    """Omit part of a string if needed to make it fit in a maximum length."""
    if len(text) > maxlen:
        pre = max(0, (maxlen-3)//2)
        post = max(0, maxlen-3-pre)
        return text[:pre] + '...' + text[len(text)-post:]
    return text

_re_stripid = re.compile(r' at 0x[0-9a-f]{6,16}(>+)$', re.IGNORECASE)
def stripid(text):
    """Remove the hexadecimal id from a Python object representation."""
    # The behaviour of %p is implementation-dependent in terms of case.
    return _re_stripid.sub(r'\1', text)

def _is_bound_method(fn):
    """
    Returns True if fn is a bound method, regardless of whether
    fn was implemented in Python or in C.
    """
    if inspect.ismethod(fn):
        return True
    if inspect.isbuiltin(fn):
        self = getattr(fn, '__self__', None)
        return not (inspect.ismodule(self) or (self is None))
    return False


def allmethods(cl):
    methods = {}
    for key, value in inspect.getmembers(cl, inspect.isroutine):
        methods[key] = 1
    for base in cl.__bases__:
        methods.update(allmethods(base)) # all your base are belong to us
    for key in methods.keys():
        methods[key] = getattr(cl, key)
    return methods

def _split_list(s, predicate):
    """Split sequence s via predicate, and return pair ([true], [false]).

    The return value is a 2-tuple of lists,
        ([x for x in s if predicate(x)],
         [x for x in s if not predicate(x)])
    """

    yes = []
    no = []
    for x in s:
        if predicate(x):
            yes.append(x)
        else:
            no.append(x)
    return yes, no

_future_feature_names = set(__future__.all_feature_names)

def visiblename(name, all=None, obj=None):
    """Decide whether to show documentation on a variable."""
    # Certain special names are redundant or internal.
    # XXX Remove __initializing__?
    if name in {'__author__', '__builtins__', '__cached__', '__credits__',
                '__date__', '__doc__', '__file__', '__spec__',
                '__loader__', '__module__', '__name__', '__package__',
                '__path__', '__qualname__', '__slots__', '__version__',
                '__static_attributes__', '__firstlineno__',
                '__annotate_func__', '__annotations_cache__'}:
        return 0
    # Private names are hidden, but special names are displayed.
    if name.startswith('__') and name.endswith('__'): return 1
    # Namedtuples have public fields and methods with a single leading underscore
    if name.startswith('_') and hasattr(obj, '_fields'):
        return True
    # Ignore __future__ imports.
    if obj is not __future__ and name in _future_feature_names:
        if isinstance(getattr(obj, name, None), __future__._Feature):
            return False
    if all is not None:
        # only document that which the programmer exported in __all__
        return name in all
    else:
        return not name.startswith('_')

def classify_class_attrs(object):
    """Wrap inspect.classify_class_attrs, with fixup for data descriptors and bound methods."""
    results = []
    for (name, kind, cls, value) in inspect.classify_class_attrs(object):
        if inspect.isdatadescriptor(value):
            kind = 'data descriptor'
            if isinstance(value, property) and value.fset is None:
                kind = 'readonly property'
        elif kind == 'method' and _is_bound_method(value):
            kind = 'static method'
        results.append((name, kind, cls, value))
    return results

def sort_attributes(attrs, object):
    'Sort the attrs list in-place by _fields and then alphabetically by name'
    # This allows data descriptors to be ordered according
    # to a _fields attribute if present.
    fields = getattr(object, '_fields', [])
    try:
        field_order = {name : i-len(fields) for (i, name) in enumerate(fields)}
    except TypeError:
        field_order = {}
    keyfunc = lambda attr: (field_order.get(attr[0], 0), attr[0])
    attrs.sort(key=keyfunc)

# ----------------------------------------------------- module manipulation


def describe(thing):
    """Produce a short description of the given thing."""
    if inspect.ismodule(thing):
        if thing.__name__ in sys.builtin_module_names:
            return 'built-in module ' + thing.__name__
        if hasattr(thing, '__path__'):
            return 'package ' + thing.__name__
        else:
            return 'module ' + thing.__name__
    if inspect.isbuiltin(thing):
        return 'built-in function ' + thing.__name__
    if inspect.isgetsetdescriptor(thing):
        return 'getset descriptor %s.%s.%s' % (
            thing.__objclass__.__module__, thing.__objclass__.__name__,
            thing.__name__)
    if inspect.ismemberdescriptor(thing):
        return 'member descriptor %s.%s.%s' % (
            thing.__objclass__.__module__, thing.__objclass__.__name__,
            thing.__name__)
    if inspect.isclass(thing):
        return 'class ' + thing.__name__
    if inspect.isfunction(thing):
        return 'function ' + thing.__name__
    if inspect.ismethod(thing):
        return 'method ' + thing.__name__
    if inspect.ismethodwrapper(thing):
        return 'method wrapper ' + thing.__name__
    if inspect.ismethoddescriptor(thing):
        try:
            return 'method descriptor ' + thing.__name__
        except AttributeError:
            pass
    return type(thing).__name__


def resolve(thing, forceload=0):
    name = getattr(thing, "__name__", None)
    return thing, name if isinstance(name, str) else None


class Doc:

    def document(self, object, name=None, *args):
        """Generate documentation for an object."""
        args = (object, name) + args
        # 'try' clause is to attempt to handle the possibility that inspect
        # identifies something in a way that pydoc itself has issues handling;
        # think 'super' and how it is a descriptor (which raises the exception
        # by lacking a __name__ attribute) and an instance.
        try:
            if inspect.ismodule(object): return self.docmodule(*args)
            if inspect.isclass(object): return self.docclass(*args)
            if inspect.isroutine(object): return self.docroutine(*args)
        except AttributeError:
            pass
        if inspect.isdatadescriptor(object): return self.docdata(*args)
        return self.docother(*args)

    def fail(self, object, name=None, *args):
        """Raise an exception for unimplemented types."""
        message = "don't know how to document object%s of type %s" % (
            name and ' ' + repr(name), type(object).__name__)
        raise TypeError(message)

    docmodule = docclass = docroutine = docother = docproperty = docdata = fail


class TextRepr(Repr):
    """Class for safely making a text representation of a Python object."""
    def __init__(self):
        Repr.__init__(self)
        self.maxlist = self.maxtuple = 20
        self.maxdict = 10
        self.maxstring = self.maxother = 100

    def repr1(self, x, level):
        if hasattr(type(x), '__name__'):
            methodname = 'repr_' + '_'.join(type(x).__name__.split())
            if hasattr(self, methodname):
                return getattr(self, methodname)(x, level)
        return cram(stripid(repr(x)), self.maxother)

    def repr_string(self, x, level):
        test = cram(x, self.maxstring)
        testrepr = repr(test)
        if '\\' in test and '\\' not in replace(testrepr, r'\\', ''):
            # Backslashes are only literal in the string and are never
            # needed to make any special characters, so show a raw string.
            return 'r' + testrepr[0] + test + testrepr[0]
        return testrepr

    repr_str = repr_string

    def repr_instance(self, x, level):
        try:
            return cram(stripid(repr(x)), self.maxstring)
        except:
            return '<%s instance>' % x.__class__.__name__


class TextDoc(Doc):
    """Formatter class for text documentation."""

    # ------------------------------------------- text formatting utilities

    _repr_instance = TextRepr()
    repr = _repr_instance.repr

    def bold(self, text):
        """Format a string in bold by overstriking."""
        return ''.join(ch + '\b' + ch for ch in text)

    def indent(self, text, prefix='    '):
        """Indent text by prepending a given prefix to each line."""
        if not text: return ''
        lines = [(prefix + line).rstrip() for line in text.split('\n')]
        return '\n'.join(lines)

    def section(self, title, contents):
        """Format a section with a given heading."""
        clean_contents = self.indent(contents).rstrip()
        return self.bold(title) + '\n' + clean_contents + '\n\n'

    # ---------------------------------------------- type-specific routines

    def docclass(self, object, name=None, mod=None, *ignored):
        """Produce text documentation for a given class object."""
        realname = object.__name__
        name = name or realname
        bases = object.__bases__

        def makename(c, m=object.__module__):
            return classname(c, m)

        if name == realname:
            title = 'class ' + self.bold(realname)
        else:
            title = self.bold(name) + ' = class ' + realname
        if bases:
            parents = map(makename, bases)
            title = title + '(%s)' % ', '.join(parents)

        contents = []
        push = contents.append

        argspec = _getargspec(object)
        if argspec and argspec != '()':
            push(name + argspec + '\n')

        doc = getdoc(object)
        if doc:
            push(doc + '\n')

        # List the mro, if non-trivial.
        mro = deque(inspect.getmro(object))
        if len(mro) > 2:
            push("Method resolution order:")
            for base in mro:
                push('    ' + makename(base))
            push('')

        # List the built-in subclasses, if any:
        subclasses = sorted(
            (str(cls.__name__) for cls in type.__subclasses__(object)
             if (not cls.__name__.startswith("_") and
                 getattr(cls, '__module__', '') == "builtins")),
            key=str.lower
        )
        no_of_subclasses = len(subclasses)
        MAX_SUBCLASSES_TO_DISPLAY = 4
        if subclasses:
            push("Built-in subclasses:")
            for subclassname in subclasses[:MAX_SUBCLASSES_TO_DISPLAY]:
                push('    ' + subclassname)
            if no_of_subclasses > MAX_SUBCLASSES_TO_DISPLAY:
                push('    ... and ' +
                     str(no_of_subclasses - MAX_SUBCLASSES_TO_DISPLAY) +
                     ' other subclasses')
            push('')

        # Cute little class to pump out a horizontal rule between sections.
        class HorizontalRule:
            def __init__(self):
                self.needone = 0
            def maybe(self):
                if self.needone:
                    push('-' * 70)
                self.needone = 1
        hr = HorizontalRule()

        def spill(msg, attrs, predicate):
            ok, attrs = _split_list(attrs, predicate)
            if ok:
                hr.maybe()
                push(msg)
                for name, kind, homecls, value in ok:
                    try:
                        value = getattr(object, name)
                    except Exception:
                        # Some descriptors may meet a failure in their __get__.
                        # (bug #1785)
                        push(self.docdata(value, name, mod))
                    else:
                        push(self.document(value,
                                        name, mod, object, homecls))
            return attrs

        def spilldescriptors(msg, attrs, predicate):
            ok, attrs = _split_list(attrs, predicate)
            if ok:
                hr.maybe()
                push(msg)
                for name, kind, homecls, value in ok:
                    push(self.docdata(value, name, mod))
            return attrs

        def spilldata(msg, attrs, predicate):
            ok, attrs = _split_list(attrs, predicate)
            if ok:
                hr.maybe()
                push(msg)
                for name, kind, homecls, value in ok:
                    doc = getdoc(value)
                    try:
                        obj = getattr(object, name)
                    except AttributeError:
                        obj = homecls.__dict__[name]
                    push(self.docother(obj, name, mod, maxlen=70, doc=doc) +
                         '\n')
            return attrs

        attrs = [(name, kind, cls, value)
                 for name, kind, cls, value in classify_class_attrs(object)
                 if visiblename(name, obj=object)]

        while attrs:
            if mro:
                thisclass = mro.popleft()
            else:
                thisclass = attrs[0][2]
            attrs, inherited = _split_list(attrs, lambda t: t[2] is thisclass)

            if object is not builtins.object and thisclass is builtins.object:
                attrs = inherited
                continue
            elif thisclass is object:
                tag = "defined here"
            else:
                tag = "inherited from %s" % classname(thisclass,
                                                      object.__module__)

            sort_attributes(attrs, object)

            # Pump out the attrs, segregated by kind.
            attrs = spill("Methods %s:\n" % tag, attrs,
                          lambda t: t[1] == 'method')
            attrs = spill("Class methods %s:\n" % tag, attrs,
                          lambda t: t[1] == 'class method')
            attrs = spill("Static methods %s:\n" % tag, attrs,
                          lambda t: t[1] == 'static method')
            attrs = spilldescriptors("Readonly properties %s:\n" % tag, attrs,
                                     lambda t: t[1] == 'readonly property')
            attrs = spilldescriptors("Data descriptors %s:\n" % tag, attrs,
                                     lambda t: t[1] == 'data descriptor')
            attrs = spilldata("Data and other attributes %s:\n" % tag, attrs,
                              lambda t: t[1] == 'data')

            assert attrs == []
            attrs = inherited

        contents = '\n'.join(contents)
        if not contents:
            return title + '\n'
        return title + '\n' + self.indent(contents.rstrip(), ' |  ') + '\n'

    def formatvalue(self, object):
        """Format an argument default value as text."""
        return '=' + self.repr(object)

    def docroutine(self, object, name=None, mod=None, cl=None, homecls=None):
        """Produce text documentation for a function or method object."""
        realname = object.__name__
        name = name or realname
        if homecls is None:
            homecls = cl
        note = ''
        skipdocs = False
        imfunc = None
        if _is_bound_method(object):
            imself = object.__self__
            if imself is cl:
                imfunc = getattr(object, '__func__', None)
            elif inspect.isclass(imself):
                note = ' class method of %s' % classname(imself, mod)
            else:
                note = ' method of %s instance' % classname(
                    imself.__class__, mod)
        elif (inspect.ismethoddescriptor(object) or
              inspect.ismethodwrapper(object)):
            try:
                objclass = object.__objclass__
            except AttributeError:
                pass
            else:
                if cl is None:
                    note = ' unbound %s method' % classname(objclass, mod)
                elif objclass is not homecls:
                    note = ' from ' + classname(objclass, mod)
        else:
            imfunc = object
        if inspect.isfunction(imfunc) and homecls is not None and (
            imfunc.__module__ != homecls.__module__ or
            imfunc.__qualname__ != homecls.__qualname__ + '.' + realname):
            pname = parentname(imfunc, mod)
            if pname:
                note = ' from %s' % pname

        if (inspect.iscoroutinefunction(object) or
                inspect.isasyncgenfunction(object)):
            asyncqualifier = 'async '
        else:
            asyncqualifier = ''

        if name == realname:
            title = self.bold(realname)
        else:
            if (cl is not None and
                inspect.getattr_static(cl, realname, []) is object):
                skipdocs = True
                if note.startswith(' from '):
                    note = ''
            title = self.bold(name) + ' = ' + realname
        argspec = None

        if inspect.isroutine(object):
            argspec = _getargspec(object)
            if argspec and realname == '<lambda>':
                title = self.bold(name) + ' lambda '
                # XXX lambda's won't usually have func_annotations['return']
                # since the syntax doesn't support but it is possible.
                # So removing parentheses isn't truly safe.
                if not object.__annotations__:
                    argspec = argspec[1:-1]
        if not argspec:
            argspec = '(...)'
        decl = asyncqualifier + title + argspec + note

        if skipdocs:
            return decl + '\n'
        else:
            doc = getdoc(object) or ''
            return decl + '\n' + (doc and self.indent(doc).rstrip() + '\n')

    def docdata(self, object, name=None, mod=None, cl=None, *ignored):
        """Produce text documentation for a data descriptor."""
        results = []
        push = results.append

        if name:
            push(self.bold(name))
            push('\n')
        doc = getdoc(object) or ''
        if doc:
            push(self.indent(doc))
            push('\n')
        return ''.join(results)

    docproperty = docdata

    def docother(self, object, name=None, mod=None, parent=None, *ignored,
                 maxlen=None, doc=None):
        """Produce text documentation for a data object."""
        repr = self.repr(object)
        if maxlen:
            line = (name and name + ' = ' or '') + repr
            chop = maxlen - len(line)
            if chop < 0: repr = repr[:chop] + '...'
        line = (name and self.bold(name) + ' = ' or '') + repr
        if not doc:
            doc = getdoc(object)
        if doc:
            line += '\n' + self.indent(str(doc)) + '\n'
        return line

class _PlainTextDoc(TextDoc):
    """Subclass of TextDoc which overrides string styling"""
    def bold(self, text):
        return text


plaintext = _PlainTextDoc()


def render_doc(thing, title='Python Library Documentation: %s', forceload=0,
        renderer=None):
    """Render text documentation, given an object or a path to an object."""
    if renderer is None:
        renderer = text
    object, name = resolve(thing, forceload)
    desc = describe(object)
    module = inspect.getmodule(object)
    if name and '.' in name:
        desc += ' in ' + name[:name.rfind('.')]
    elif module and module is not object:
        desc += ' in module ' + module.__name__

    if not (inspect.ismodule(object) or
              inspect.isclass(object) or
              inspect.isroutine(object) or
              inspect.isdatadescriptor(object) or
              _getdoc(object)):
        # If the passed object is a piece of data or an instance,
        # document its available methods instead of its value.
        if hasattr(object, '__origin__'):
            object = object.__origin__
        else:
            object = type(object)
            desc += ' object'
    return title % desc + '\n\n' + renderer.document(object, name)
`;
