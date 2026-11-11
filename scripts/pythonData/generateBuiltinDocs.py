# Prints, as JSON, the docstrings and text signatures of the modules this grader implements, of their functions and
# classes, and of the classes' attributes, keyed by `module.qualname[.attribute]`, from the CPython (3.14.10) that runs it:
#   ~/Documents/tokyo-online-university/step-interpreter/scripts/ref python scripts/pythonData/generateBuiltinDocs.py \
#     > .tmp/builtinDocs.json
# Run it from the repository root, since it reads the module list from src/python/moduleNames.ts; then
# scripts/generateBuiltinDocs.ts keeps the entries of what this grader implements natively.
import contextlib
import importlib
import io
import json
import re
import sys
import types
import warnings

DESCRIPTORS = (types.BuiltinFunctionType, types.MethodDescriptorType, types.WrapperDescriptorType,
               types.ClassMethodDescriptorType, types.GetSetDescriptorType, types.MemberDescriptorType,
               types.FunctionType, staticmethod, classmethod, property)
HEAPTYPE = 1 << 9


def main():
    with open('src/python/moduleNames.ts', encoding='utf-8') as file:
        source = file.read()
    listed = re.search(r'SUPPORTED_MODULES[^\[]*\[(.*?)\]\);', source, re.S).group(1)
    modules = [name for name in re.findall(r"'([^']+)'", listed) if name != '__main__']
    entries = {}
    classes = []
    warnings.simplefilter('ignore')
    for name in modules:
        try:
            # A module such as `this` prints when imported.
            with contextlib.redirect_stdout(io.StringIO()):
                module = importlib.import_module(name)
        except ImportError:
            continue
        add_module(entries, classes, name, module)
    add_classes(entries, classes + [(cls, cls.__module__) for cls in builtin_types()])
    json.dump(entries, sys.stdout, indent=0, sort_keys=True, ensure_ascii=False)
    print()


def add_module(entries, classes, name, module):
    """Adds the entries of a module and its functions, and collects its classes."""
    add(entries, name, module.__doc__, None)
    for attribute, value in vars(module).items():
        # The C accelerator a module's builtin function comes from, as `@module.name`.
        if isinstance(value, types.BuiltinFunctionType) and isinstance(value.__self__, types.ModuleType):
            if value.__module__ not in (None, name):
                entries.setdefault(f'@{name}.{attribute}', [value.__module__, None])
        if isinstance(value, type):
            classes.append((value, name))
        elif isinstance(value, (types.BuiltinFunctionType, types.FunctionType)):
            owner = getattr(value, '__module__', None) or name
            # Also under the module that holds it, which may define it in this grader, as `operator` does.
            for module_name in (owner, name):
                add(entries, f'{module_name}.{value.__qualname__}', value.__doc__, text_signature(value))


def add_classes(entries, pending):
    """Adds the entries of classes, each under its module and the module holding it, and of their nested classes."""
    seen = set()
    while pending:
        cls, holder = pending.pop()
        if (cls, holder) in seen:
            continue
        seen.add((cls, holder))
        for module_name in {cls.__module__, holder}:
            # Another class of the name, as _Element_Py beside the C Element, is not the one the module names.
            named = getattr(sys.modules.get(module_name), cls.__qualname__, cls)
            if named is cls or not isinstance(named, type):
                pending.extend(add_class(entries, f'{module_name}.{cls.__qualname__}', cls))


def add_class(entries, key, cls):
    """Adds the entries of a class and its attributes under `key`, returning its nested classes."""
    # A type whose objects have a __doc__ member, as property's, keeps its own docstring in tp_doc.
    doc = cls.__dict__.get('__doc__')
    add(entries, key, doc if isinstance(doc, str) else type.__dict__['__doc__'].__get__(cls), getattr(cls, '__text_signature__', None))
    if not cls.__flags__ & HEAPTYPE or '__firstlineno__' not in cls.__dict__:
        # The kinds of a C type's attributes, as `!module.qualname`, which pydoc's help shows; C types of modules,
        # such as _elementtree's, are heap types, but unlike classes written in Python have no __firstlineno__.
        entries.setdefault(f'!{key}', [class_layout(cls), None])
    nested = []
    for attribute, value in cls.__dict__.items():
        if isinstance(value, type):
            nested.append((value, value.__module__))
        elif isinstance(value, DESCRIPTORS):
            function = getattr(value, '__func__', value)
            add(entries, f'{key}.{attribute}', getattr(function, '__doc__', None), text_signature(function))
    return nested


def class_layout(cls):
    return ' '.join(sorted(f'{name}:{type(value).__name__}' for name, value in cls.__dict__.items()))


def builtin_types():
    """The builtin types, including those no module names, such as the iterators."""
    found = [object]
    for cls in found:
        found.extend(sub for sub in type.__subclasses__(cls) if sub not in found and sub.__module__ == 'builtins')
    for value in [iter([]), iter(()), iter(''), iter({}), iter(set()), iter(range(1)), reversed([]), {}.keys(),
                  {}.values(), {}.items(), iter({}.keys()), iter({}.values()), iter({}.items()), iter(b''),
                  iter(bytearray()), (x for x in []), len, [].append, type.__dict__, sys.flags]:
        found.append(type(value))
    return found


def text_signature(value):
    signature = getattr(value, '__text_signature__', None)
    return signature if isinstance(signature, str) else None


def add(entries, key, doc, signature):
    if isinstance(doc, str) or signature is not None:
        entries.setdefault(key, [doc if isinstance(doc, str) else None, signature])


if __name__ == '__main__':
    main()
