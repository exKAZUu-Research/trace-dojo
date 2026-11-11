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
        add(entries, name, module.__doc__, None)
        for value in vars(module).values():
            if isinstance(value, type):
                classes.append((value, name))
            elif isinstance(value, (types.BuiltinFunctionType, types.FunctionType)):
                owner = getattr(value, '__module__', None) or name
                # Also under the module that holds it, which may define it in this grader, as `operator` does.
                for module_name in (owner, name):
                    add(entries, f'{module_name}.{value.__qualname__}', value.__doc__, text_signature(value))
    seen = set()
    pending = classes + [(cls, cls.__module__) for cls in builtin_types()]
    while pending:
        cls, holder = pending.pop()
        if (cls, holder) in seen:
            continue
        seen.add((cls, holder))
        for module_name in {cls.__module__, holder}:
            key = f'{module_name}.{cls.__qualname__}'
            add(entries, key, cls.__dict__.get('__doc__'), getattr(cls, '__text_signature__', None))
            for attribute, value in cls.__dict__.items():
                if isinstance(value, type):
                    pending.append((value, value.__module__))
                elif isinstance(value, DESCRIPTORS):
                    function = getattr(value, '__func__', value)
                    add(entries, f'{key}.{attribute}', getattr(function, '__doc__', None), text_signature(function))
    json.dump(entries, sys.stdout, indent=0, sort_keys=True, ensure_ascii=False)
    print()


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
