"""Emit the global C declarations and std names visible through each Apple Clang 21 arm64 header."""

import json
import re
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TREE_NODE = re.compile(r"^((?:[| ] )*)(?:\|-|`-)(\w+) (.*)")
TYPE_NAME = re.compile(r"\b\w+\b")
USING_SHADOW = re.compile(r" (\w+) 0x\w+ '([^']+)'(?: '([^']+)')?")
NAMED_TAG = re.compile(r" (?:struct|class|union|enum) ([A-Za-z]\w*)(?: definition)?$")
SEMANTIC_PARENT = re.compile(r"^0x\w+ parent 0x\w+")
STD_FUNCTIONS = {"FunctionDecl": "stdFunction", "FunctionTemplateDecl": "stdTemplate"}
USING_KINDS = {
    "Function": "function", "FunctionTemplate": "template", "Var": "var",
    **dict.fromkeys(("Typedef", "TypeAlias", "TypeAliasTemplate", "ClassTemplate", "CXXRecord", "Record", "Enum"), "type"),
}
STD_OTHER_NAMES = {
    "ClassTemplateDecl", "ConceptDecl", "CXXRecordDecl", "EnumDecl", "NamespaceAliasDecl",
    "NamespaceDecl", "TypeAliasDecl", "TypeAliasTemplateDecl", "TypedefDecl", "VarDecl", "VarTemplateDecl",
}


def probe(header):
    result = subprocess.run(
        ["clang++", "-std=c++20", "-x", "c++", "-fsyntax-only", "-Xclang", "-ast-dump", "-"],
        input=f"#include <{header}>\n", capture_output=True, text=True, check=True,
    )
    symbols = global_symbols(result.stdout)

    macros = subprocess.run(
        ["clang++", "-std=c++20", "-x", "c++", "-dM", "-E", "-"],
        input=f"#include <{header}>\n", capture_output=True, text=True, check=True,
    ).stdout
    for name, function_like in re.findall(r"^#define ([A-Za-z]\w*)(\(|(?= |$))", macros, re.M):
        symbols.add((name, "functionMacro" if function_like else "macro", ""))
    for name, kind in std_nodes(result.stdout):
        if name.isidentifier() and not name.startswith("_"):
            symbols.add((name, kind, ""))
    return symbols


def global_symbols(tree):
    aliases = {}
    declarations = set()
    for category, syntax, has_body in global_nodes(tree):
        if category not in {"TypedefDecl", "TypeAliasDecl", "FunctionDecl", "VarDecl"}:
            declaration = other_global_symbol(category, syntax)
            if declaration:
                declarations.add(declaration)
            continue
        head, sep, full_type = syntax.partition(" '")
        if not sep:
            continue
        name = head.rsplit(None, 1)[-1]
        signature = full_type.split("'", 1)[0]
        if category in {"TypedefDecl", "TypeAliasDecl"}:
            if name not in TYPE_NAME.findall(signature):
                aliases[name] = signature
            declarations.add((name, "type", ""))
            continue
        kind = "var" if category == "VarDecl" else "definition" if has_body else "function"
        declarations.add((name, kind, signature))

    symbols = {
        (name, kind, normalize_type(signature, aliases))
        for name, kind, signature in declarations
        if name.isidentifier() and not name.startswith("_")
    }
    return symbols


def other_global_symbol(category, syntax):
    if category == "UsingShadowDecl":
        imported = using_symbol(syntax)
        if imported:
            name, kind, signature = imported
            return name, "using" if kind in {"function", "template"} else kind, signature
    if category in {"RecordDecl", "CXXRecordDecl", "EnumDecl"}:
        tag = NAMED_TAG.search(syntax)
        if tag:
            return tag[1], "type", ""


def std_nodes(tree):
    ancestors = []
    for line in tree.splitlines():
        match = TREE_NODE.match(line)
        if not match:
            continue
        prefix, category, syntax = match.groups()
        depth = len(prefix) // 2
        del ancestors[depth:]
        name, is_inline = declaration_name(category, syntax)
        in_std = (
            bool(ancestors)
            and ancestors[0] == ("NamespaceDecl", "std", False)
            and not SEMANTIC_PARENT.match(syntax)
            and all(node == "LinkageSpecDecl" or node == "NamespaceDecl" and inline for node, _, inline in ancestors[1:])
        )
        ancestors.append((category, name, is_inline))
        if not in_std:
            continue
        if category == "UsingShadowDecl":
            imported = using_symbol(syntax)
            if imported:
                imported_name, kind, _ = imported
                yield imported_name, f"std{kind.title()}" if kind in {"function", "template"} else "stdOther"
        elif name and category in STD_FUNCTIONS:
            yield name, STD_FUNCTIONS[category]
        elif name and category in STD_OTHER_NAMES:
            yield name, "stdOther"


def using_symbol(syntax):
    shadow = USING_SHADOW.search(syntax)
    if shadow:
        target, name, signature = shadow.groups()
        kind = USING_KINDS.get(target)
        if kind:
            return name, kind, "" if kind == "type" else signature or ""


def declaration_name(category, syntax):
    if category not in STD_FUNCTIONS and category not in STD_OTHER_NAMES:
        return "", False
    head = syntax.partition(" '")[0]
    words = head.split()
    inline = category == "NamespaceDecl" and "inline" in words
    if category == "CXXRecordDecl" and words[-1] == "definition":
        words.pop()
    if category == "NamespaceDecl" and words[-1] == "inline":
        words.pop()
    return words[-1], inline


def global_nodes(tree):
    ancestors = []
    item = None
    for line in tree.splitlines():
        match = TREE_NODE.match(line)
        if not match:
            continue
        prefix, category, syntax = match.groups()
        depth = len(prefix) // 2
        del ancestors[depth:]
        if all(node == "LinkageSpecDecl" for node in ancestors) and not SEMANTIC_PARENT.match(syntax):
            if item:
                yield item
            item = category, syntax, False
        elif item and category in {"CompoundStmt", "CXXTryStmt"} and ancestors[-1] == "FunctionDecl":
            if all(node == "LinkageSpecDecl" for node in ancestors[:-1]):
                item = item[0], item[1], True
        ancestors.append(category)
    if item:
        yield item


def normalize_type(signature, aliases):
    signature = re.split(r"\s+(?:noexcept\b|__attribute__)", signature, maxsplit=1)[0]
    for _ in range(4):
        following = TYPE_NAME.sub(lambda match: aliases.get(match[0], match[0]), signature)
        if following == signature:
            break
        signature = following
    return re.sub(r"\b_(?:Nonnull|Nullable|Null_unspecified)\b", "", signature).strip()


def math_wrapper_calls():
    source = Path("src/c/library/mathFunctions.ts").read_text()
    families = {"fma": 3}
    for family, arity in (("UNARY", 1), ("BINARY", 2)):
        block = source.split(f"export const {family}:", 1)[1].split("\n};", 1)[0]
        for name in re.findall(r"^  ([a-z]\w*)(?:,|:)", block, re.M):
            families[name] = arity
    requests = [
        (name, arity, kind, argument, result, suffix)
        for name, arity in sorted(families.items())
        for kind, argument, result, suffix in (
            ("integer", "int", "double", ""),
            ("double", "double", "double", ""),
            ("float", "float", "float", "f"),
            ("ldouble", "long double", "long double", "l"),
        )
    ]
    calls = defaultdict(dict)
    with ThreadPoolExecutor(4) as pool:
        for (name, _, kind, *_), symbol in zip(requests, pool.map(math_wrapper_symbol, requests)):
            if symbol:
                calls[name][kind] = symbol
    return calls


def math_wrapper_symbol(request):
    name, arity, _, argument, result, suffix = request
    params = ", ".join(f"{argument} a{i}" for i in range(arity))
    args = ", ".join(f"a{i}" for i in range(arity))
    code = f'#include <cmath>\nextern "C" {result} probe({params}) {{ return std::{name}({args}); }}\n'
    assembly = subprocess.run(
        ["clang++", "-std=c++20", "-O0", "-x", "c++", "-S", "-o", "-", "-"],
        input=code, capture_output=True, text=True, check=True,
    ).stdout
    for symbol in (name + suffix, name):
        if re.search(rf"^\s+b(?:l)?\s+_{re.escape(symbol)}\s*$", assembly, re.M):
            return symbol


def main():
    target = subprocess.check_output(["clang++", "--version"], text=True)
    if not target.startswith("Apple clang version 21.") or not re.search(r"Target: arm64-apple-", target):
        raise SystemExit("Use Apple Clang 21 targeting arm64 macOS.")
    source = Path("src/cpp/library/headers.ts").read_text()
    headers = sorted(re.findall(r"^  '([^']+)',", source.split("const MISSING_HEADERS")[0], re.M))
    presence = defaultdict(list)
    with ThreadPoolExecutor(4) as pool:
        for header, globals_ in zip(headers, pool.map(probe, headers)):
            for declaration in globals_:
                presence[declaration].append(header)
    groups = sorted({tuple(found) for found in presence.values()})
    group_id = {group: i for i, group in enumerate(groups)}
    names = defaultdict(list)
    types = {}
    macros = {}
    function_macros = {}
    standard = defaultdict(list)
    for (name, kind, signature), found in sorted(presence.items()):
        group = group_id[tuple(found)]
        if kind == "macro":
            macros[name] = group
        elif kind == "functionMacro":
            function_macros[name] = group
        elif kind == "type":
            types[name] = group
        elif kind.startswith("std"):
            standard[name].append([group, kind[3:].lower()])
        else:
            names[name].append([group, kind, signature])
    output = Path("src/cpp/library/libcGlobalDeclarations.json")
    output.write_text(json.dumps({
        "headers": groups,
        "declarations": names,
        "types": types,
        "macros": macros,
        "functionMacros": function_macros,
        "standard": standard,
        "mathCalls": math_wrapper_calls(),
    }, indent=2) + "\n")
    subprocess.run(["bun", "fmt", "--no-script", "--no-config", str(output)], check=True)


if __name__ == "__main__":
    main()
